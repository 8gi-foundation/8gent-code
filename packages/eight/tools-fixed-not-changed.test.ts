/**
 * #3126: check_agent said "changed src/wordcount.ts" in pilot run
 * 2026-09-30_083409 while the file still held its bug, and the Orchestrator
 * reported both files fixed. The pool now hashes each scoped file at spawn and,
 * when the agent ends, runs the file's sibling test (bounded, inside the work
 * dir). FIXED needs a passing test; anything else says what it is.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const WORDCOUNT =
	'export function wordCount(text: string): number {\n\treturn text.split(" ").length;\n}\n';
const CLAMP =
	"export function clamp(n: number, min: number, max: number): number {\n\treturn Math.max(max, Math.min(n, min));\n}\n";
const WORDCOUNT_TEST =
	'import { expect, test } from "bun:test";\nimport { wordCount } from "./wordcount";\ntest("counts words", () => {\n\texpect(wordCount("  hello   world\\n")).toBe(2);\n});\n';
const CLAMP_TEST =
	'import { expect, test } from "bun:test";\nimport { clamp } from "./clamp";\ntest("limits values outside the range", () => {\n\texpect(clamp(11, 0, 10)).toBe(10);\n});\n';
const HANG_TEST =
	'import { test } from "bun:test";\ntest("slow", async () => {\n\tawait Bun.sleep(8000);\n}, 20000);\n';

type Check = {
	status: string;
	outcome: string;
	filesChanged: string[];
	respawnNow?: Array<{ agentId: string }>;
};

function runProbe(mode?: "deny") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-not-changed-"));
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "wordcount.ts"), WORDCOUNT);
	fs.writeFileSync(path.join(dir, "src", "wordcount.test.ts"), WORDCOUNT_TEST);
	fs.writeFileSync(path.join(dir, "src", "clamp.ts"), CLAMP);
	fs.writeFileSync(path.join(dir, "src", "clamp.test.ts"), CLAMP_TEST);
	fs.writeFileSync(path.join(dir, "src", "hang.test.ts"), HANG_TEST);
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-not-changed-home-"));
	const r = Bun.spawnSync(
		[
			"bun",
			path.join(import.meta.dir, "__tests__", "fixtures", "fixed-probe.ts"),
			dir,
			...(mode ? [mode] : []),
		],
		{
			env: {
				...process.env,
				HOME: home,
				EIGHT_CHECK_AGENT_WAIT_MS: "0",
				EIGHT_VERIFY_TEST_TIMEOUT_MS: "1500",
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
	return JSON.parse(line.slice("@@PROBE@@".length)) as Record<string, Check>;
}

describe("check_agent says FIXED only with a passing test (#3126)", () => {
	let out: ReturnType<typeof runProbe>;
	beforeAll(() => {
		out = runProbe();
	}, 90_000);

	test("the pilot's 083409 shape: a rewrite with the same bug is not a change", () => {
		expect(out.same.filesChanged).toEqual(["src/wordcount.ts"]);
		expect(out.same.outcome).toStartWith(
			"ENDED WITHOUT CHANGING src/wordcount.ts (it wrote src/wordcount.ts but left the content as it was).",
		);
		expect(out.same.outcome).toContain("Its task is NOT done");
		expect(out.same.outcome).not.toContain("FIXED");
	});

	test("a change whose test fails says so, with the first failing line, and asks for a re-spawn", () => {
		expect(out.buggy.outcome).toStartWith(
			"CHANGED BUT ITS TEST FAILS: src/clamp.ts (src/clamp.test.ts: (fail) limits values outside the range",
		);
		expect(out.buggy.outcome).toContain("Re-spawn it now");
		expect(out.notest.respawnNow?.length ?? 0).toBeGreaterThanOrEqual(1);
	});

	test("no sibling test: changed, not verified", () => {
		expect(out.notest.outcome).toBe("changed src/extra.ts, not verified (no test)");
	});

	test("a test that outlasts the timeout is not verified, and is not a failure", () => {
		expect(out.hang.outcome).toBe(
			"changed src/hang.ts, not verified (src/hang.test.ts did not finish in 2s)",
		);
	});

	test("nothing says FIXED without a passing test", () => {
		for (const c of Object.values(out)) expect(c.outcome).not.toContain("FIXED");
	});
});

// #3126 review: the verify run executes code a sub-agent just wrote, so it goes
// through the same gates as the agent's own run_command. A gate that says no
// is reported; it never turns into FIXED.
describe("the verify run obeys the run_command gates", () => {
	test("permission policy denies bun test: a correct fix reads as blocked, never FIXED", () => {
		const out = runProbe("deny");
		expect(out.good.status).toBe("completed");
		expect(out.good.filesChanged).toEqual(["src/clamp.ts"]);
		expect(out.good.outcome).toStartWith(
			"changed src/clamp.ts, not verified (verification blocked by [PERMISSION DENIED] Command blocked by security policy: bun test ./src/clamp.test.ts)",
		);
		expect(out.good.outcome).not.toContain("FIXED");
	}, 90_000);
});
