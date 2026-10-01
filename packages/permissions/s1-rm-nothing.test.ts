/**
 * #3168: System One must not block an `rm` that deletes nothing.
 *
 * The exact pilot case (l5-feature-e2e, main 459eb7f2): the agent created
 * `bunout.txt` with a shell redirect, then ran `rm -f .bunout.txt`, a path that
 * never existed. rm_non_temp escalated and the judge blocked it.
 *
 * The judge here is a stub that answers "dangerous" to everything, so any
 * command that reaches it is blocked. A command the new rule passes never
 * reaches it; every negative must still reach it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { rmOfNothing } from "./s1-rm-nothing";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

// Remove the temp dirs tempDir() has recorded, this file's included (#3285).
afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

const PILOT = "rm -f .bunout.txt";

let ws: string;
let outside: string;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

beforeEach(() => {
	ws = tempDir("s1-rm-ws-");
	outside = tempDir("s1-rm-out-");
	// The pilot's scratch file, as the agent made it: a shell redirect.
	execFileSync("sh", ["-c", "echo '7 pass' > bunout.txt"], { cwd: ws });
	// A tracked file.
	execFileSync("git", ["init", "-q"], { cwd: ws });
	writeFileSync(join(ws, "notes.md"), "tracked");
	execFileSync("git", ["add", "notes.md"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], {
		cwd: ws,
	});
	// An untracked file that was there before the session.
	writeFileSync(join(ws, "old.log"), "pre-existing");
	mkdirSync(join(ws, "build"));
	writeFileSync(join(ws, "build", "out.js"), "x");
	// A symlinked directory inside the workspace that points outside it.
	symlinkSync(outside, join(ws, "escape"));
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-rm-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
});

describe("rmOfNothing", () => {
	test("the pilot case: rm -f of a dotted name that was never created", () => {
		expect(existsSync(join(ws, ".bunout.txt"))).toBe(false);
		expect(rmOfNothing(PILOT, ws)).toBe(true);
	});

	test("other plain forms of an absent target", () => {
		expect(rmOfNothing("rm .bunout.txt", ws)).toBe(true);
		expect(rmOfNothing("rm -fv .bunout.txt gone/also-gone.txt", ws)).toBe(true);
		expect(rmOfNothing("rm -f ./.bunout.txt", ws)).toBe(true);
	});

	const refused: Array<[string, string]> = [
		["a file that exists (the scratch file itself)", "rm -f bunout.txt"],
		["a tracked file", "rm -f notes.md"],
		["a pre-existing untracked file", "rm -f old.log"],
		["one existing target among absent ones", "rm -f .bunout.txt old.log"],
		["rm -rf of a directory", "rm -rf build"],
		["rm -r of an absent directory", "rm -r nothere"],
		["rm -d", "rm -d nothere"],
		["rm -i", "rm -i .bunout.txt"],
		["the end-of-options marker", "rm -f -- .bunout.txt"],
		["an absent path under a symlink that points outside", "rm -f escape/new.txt"],
		["the symlink itself", "rm -f escape"],
		["a glob", "rm -f *.txt"],
		["a glob on an absent name", "rm -f .bunout.*"],
		["a path outside the workspace by ..", "rm -f ../nope-s1.txt"],
		["an absolute path outside the workspace", "rm -f /opt/nope-s1.txt"],
		["a home path", "rm -f ~/nope-s1.txt"],
		["chaining", "rm -f .bunout.txt; rm -f bunout.txt"],
		["and-chaining", "rm -f .bunout.txt && ls"],
		["a pipe", "echo .bunout.txt | xargs rm"],
		["a variable", "rm -f $HOME/.bunout.txt"],
		["quotes", "rm -f '.bunout.txt'"],
		["a comment", "rm -f .bunout.txt # tidy"],
		["a substitution", "rm -f $(echo bunout.txt)"],
		["a wrapper", "sudo rm -f .bunout.txt"],
		["no path", "rm -f"],
	];
	for (const [why, cmd] of refused) {
		test(`refuses ${why}: ${cmd}`, () => {
			expect(rmOfNothing(cmd, ws)).toBe(false);
		});
	}

	test("the dangling symlink is never deleted through this rule", () => {
		symlinkSync(join(outside, "gone"), join(ws, "dangling"));
		expect(rmOfNothing("rm -f dangling", ws)).toBe(false);
	});

	test("no working directory, or a relative one: today's behaviour", () => {
		expect(rmOfNothing(PILOT, undefined)).toBe(false);
		expect(rmOfNothing(PILOT, "relative/dir")).toBe(false);
	});
});

describe("systemOneGate", () => {
	test("the pilot case runs without asking the judge", async () => {
		const g = await systemOneGate(PILOT, process.env, ws);
		expect(g.run).toBe(true);
		expect(g.guard?.backend).toBe("allowlist");
		expect(judge.asks).toBe(0);
	});

	test("without a working directory it goes to the judge, as today", async () => {
		const g = await systemOneGate(PILOT, process.env);
		expect(g.run).toBe(false);
		expect(g.message).toStartWith(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.asks).toBe(1);
	});

	test("EIGHT_S1_ALLOWLIST=0 turns it off with the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const g = await systemOneGate(PILOT, process.env, ws);
		expect(g.run).toBe(false);
		expect(judge.asks).toBe(1);
	});

	for (const cmd of [
		"rm -f bunout.txt",
		"rm -f notes.md",
		"rm -f old.log",
		"rm -rf build",
		"rm -f escape/new.txt",
		"rm -f *.txt",
		"rm -f ../nope-s1.txt",
	]) {
		test(`still judged: ${cmd}`, async () => {
			const g = await systemOneGate(cmd, process.env, ws);
			expect(g.run).toBe(false);
			expect(g.guard?.backend).not.toBe("allowlist");
		});
	}
});

describe("integration: the real run_command paths", () => {
	const callSdk = (command: string) =>
		(
			agentTools.run_command as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
		).execute({ command }, { toolCallId: "s1-rm", messages: [] });

	test("ToolExecutor run_command: the pilot command is not System One blocked", async () => {
		const out = await new ToolExecutor(ws, "s1-rm-test").execute("run_command", { command: PILOT });
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.asks).toBe(0);
		expect(existsSync(join(ws, "bunout.txt"))).toBe(true);
	});

	test("AI SDK run_command: the pilot command is not System One blocked", async () => {
		setToolContext({ workingDirectory: ws });
		const out = await callSdk(PILOT);
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.asks).toBe(0);
	});

	test("ToolExecutor run_command: removing an existing file is still judged and blocked", async () => {
		const out = await new ToolExecutor(ws, "s1-rm-test").execute("run_command", {
			command: "rm -f old.log",
		});
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "old.log"))).toBe(true);
	});
});
