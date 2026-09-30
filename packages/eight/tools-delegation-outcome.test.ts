/**
 * Delegation competence, from pilot run 2026-09-30_070309 (l4-spawn-parallel-m5,
 * 16/17, only "PARALLEL SUB-AGENTS PROVEN" failed). The wordCount sub-agent
 * wrote its fix as a bare JSON call with an unescaped \s, the parser dropped it,
 * and the agent ended having changed nothing. check_agent said "completed".
 * The Orchestrator noticed only by reading the file after the clamp agent had
 * finished too, so the retry ran alone and the two fixes never overlapped.
 *
 * End to end through the real ToolExecutor and agent pool (stubbed model, temp
 * HOME, child process): check_agent now waits for a sibling to finish, names the
 * one that ended without doing its task while the other still runs, and the
 * pilot's \s reply now lands.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WORDCOUNT =
	'export function wordCount(text: string): number {\n\treturn text.split(" ").length;\n}\n';
const CLAMP =
	"export function clamp(n: number, min: number, max: number): number {\n\treturn Math.max(max, Math.min(n, min));\n}\n";

type Check = {
	agentId: string;
	status: string;
	outcome: string;
	filesChanged: string[];
	allowedPaths?: string[];
	respawnNow?: Array<{ agentId: string; allowedPaths?: string[]; outcome: string }>;
};

// The twofix tests, so a finished agent's file is verified, not only seen to change (#3126).
const WORDCOUNT_TEST = `import { expect, test } from "bun:test";
import { wordCount } from "./wordcount";
test("counts words", () => {
	expect(wordCount("one two three")).toBe(3);
	expect(wordCount("  hello   world\\n")).toBe(2);
	expect(wordCount("")).toBe(0);
});
`;
const CLAMP_TEST = `import { expect, test } from "bun:test";
import { clamp } from "./clamp";
test("clamps", () => {
	expect(clamp(5, 0, 10)).toBe(5);
	expect(clamp(-1, 0, 10)).toBe(0);
	expect(clamp(11, 0, 10)).toBe(10);
});
`;

function runProbe() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-outcome-"));
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "wordcount.ts"), WORDCOUNT);
	fs.writeFileSync(path.join(dir, "src", "clamp.ts"), CLAMP);
	fs.writeFileSync(path.join(dir, "src", "wordcount.test.ts"), WORDCOUNT_TEST);
	fs.writeFileSync(path.join(dir, "src", "clamp.test.ts"), CLAMP_TEST);
	fs.writeFileSync(path.join(dir, "README.md"), "# twofix\n");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "delegation-outcome-home-"));
	const r = Bun.spawnSync(
		["bun", path.join(import.meta.dir, "__tests__", "fixtures", "delegation-probe.ts"), dir],
		{
			env: {
				...process.env,
				HOME: home,
				// Permission config lives here, not under a HOME that Docker may ignore:
				// the deny probe must never leak a rule into another test.
				EIGHT_DATA_DIR: path.join(home, ".8gent"),
				EIGHT_CHECK_AGENT_WAIT_MS: "10000",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("@@PROBE@@"));
	if (!line)
		throw new Error(
			`probe printed no result (exit ${r.exitCode}): ${r.stderr.toString().slice(-800)}`,
		);
	return JSON.parse(line.slice("@@PROBE@@".length)) as {
		slowCheckMs: number;
		quitStatusAtSlowCheck: string;
		slowWhileRunning: Check;
		quitCheck: Check;
		regexCheck: Check;
		slowDone: Check;
		scopedSpawn: Record<string, unknown>;
		unscopedSpawn: Record<string, unknown>;
		wordcount: string;
		clamp: string;
	};
}

describe("check_agent reports what a sub-agent did, while its sibling still runs", () => {
	let out: ReturnType<typeof runProbe>;
	beforeAll(() => {
		out = runProbe();
	}, 60_000);

	test("a check on a running agent returns when its sibling ends, not after a fixed sleep", () => {
		expect(out.slowWhileRunning.status).toBe("running");
		// It waited for the sibling to end, and no longer than that.
		expect(out.quitStatusAtSlowCheck).toBe("completed");
		// The quitter ends in well under a second; the slow agent needs 4 s.
		expect(out.slowCheckMs).toBeLessThan(3500);
	});

	test("the running agent's check names the sibling that ended without doing its task", () => {
		const respawn = out.slowWhileRunning.respawnNow ?? [];
		expect(respawn.map((r) => r.agentId)).toEqual([out.quitCheck.agentId]);
		expect(respawn[0].allowedPaths).toEqual(["src/wordcount.ts"]);
		expect(respawn[0].outcome).toStartWith("ENDED WITHOUT CHANGING src/wordcount.ts.");
		expect(respawn[0].outcome).toContain("Re-spawn it now");
	});

	test("the quitter's own check says its task is not done, despite status completed", () => {
		expect(out.quitCheck.status).toBe("completed");
		expect(out.quitCheck.filesChanged).toEqual([]);
		expect(out.quitCheck.outcome).toContain("Its task is NOT done");
	});

	test("the pilot's unescaped \\s reply now lands, and the re-spawn clears the alert", () => {
		expect(out.regexCheck.filesChanged).toEqual(["src/wordcount.ts"]);
		expect(out.regexCheck.outcome).toBe("FIXED src/wordcount.ts (src/wordcount.test.ts passes)");
		expect(out.wordcount).toContain("text.trim().split(/\\s+/).filter(Boolean).length");
		expect(out.slowDone.respawnNow).toBeUndefined();
	});

	test("an agent that fixed its file says FIXED, with the passing test as evidence", () => {
		expect(out.slowDone.status).toBe("completed");
		expect(out.slowDone.filesChanged).toEqual(["src/clamp.ts"]);
		expect(out.slowDone.outcome).toBe("FIXED src/clamp.ts (src/clamp.test.ts passes)");
		expect(out.clamp).toContain("Math.min(Math.max(n, min), max)");
	});

	test("spawn_agent says when an agent has no edit scope", () => {
		expect(out.scopedSpawn.allowedPaths).toEqual(["src/clamp.ts"]);
		expect(out.scopedSpawn.scope).toBeUndefined();
		expect(String(out.unscopedSpawn.scope)).toContain("pass them as allowedPaths");
	});
});
