/**
 * #4159: a plain rm of files this session's own command wrote, in this
 * project, passes System One without the judge.
 *
 * Pilot media-brief-video (main 1941d8e0, run 2026-10-13_045745), tt-17 and
 * tt-48: `bash video/build_slides.sh` ran ImageMagick, which wrote
 * video/body_1-0.png and video/body_1-1.png. No redirect named them, so the
 * session's record (#3177) never held them, and
 * `rm -f video/body_1-0.png video/body_1-1.png` went to the judge, which
 * blocked it (pYes 0.9051).
 *
 * The judge is a stub that calls every `rm` dangerous and anything else safe.
 * An rm the rule passes never reaches it (`judge.rmAsks` stays 0); every
 * negative must reach it and be blocked. All through the real tool entry
 * points (ToolExecutor.execute and the native agentTools), interactive as in
 * the TUI with the person approving every card (as the pilot does), so the
 * permission layer's card for a dangerous rm is approved and only System One
 * decides.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { CreatedFiles, watchBorn } from "./s1-created-files";
import { rmOfNothingOrOwn } from "./s1-rm-nothing";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
} from "./system-one-gate";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

afterAll(cleanupTempDirs);

class RmIsDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "rm-is-dangerous";
	rmAsks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		const rm = /\brm\b/.test(request.state);
		if (rm) this.rmAsks++;
		const yes = rm ? 0.99 : 0.001;
		return {
			answers: [
				{ id: request.questions[0].id, kind: "noul", probabilities: { yes }, confidence: 0.99 },
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

// Recording a child's file needs its birth time. Where the file system does not report one,
// nothing is recorded (fail closed) and the positive cases cannot run.
const HAS_BIRTH = (() => {
	const d = tempDir("s1-born-probe-");
	writeFileSync(join(d, "p"), "p");
	const born = statSync(join(d, "p")).birthtimeMs;
	return Number.isFinite(born) && born > 0;
})();
const POSIX = process.platform !== "win32";

let ws: string;
let outside: string;
let ttyWas: PropertyDescriptor | undefined;
let judge: RmIsDangerous;
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
	ws = tempDir("s1-born-ws-");
	outside = tempDir("s1-born-out-");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	mkdirSync(join(ws, "video"));
	judge = new RmIsDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-born-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
	registerTuiApprovalHandler(async () => "approve");
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
	registerTuiApprovalHandler(null);
	if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	process.env.EIGHT_HEADLESS = "1";
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

const PILOT_RM = "rm -f video/body_1-0.png video/body_1-1.png";

/** The pilot's shape: a script whose child process writes the intermediates, named by no redirect. */
const BUILD = [
	"#!/usr/bin/env bash",
	"set -e",
	'cd "$(dirname "$0")"',
	"printf 'png0' > body_1-0.png",
	"printf 'png1' > body_1-1.png",
	"printf 'slide' > slide_1.png",
	"",
].join("\n");

type Agent = {
	run: (command: string) => Promise<string>;
	write: (path: string, content: string) => Promise<string>;
};

function executorAgent(ex: ToolExecutor): Agent {
	return {
		run: (command) => ex.execute("run_command", { command }),
		write: (path, content) => ex.execute("write_file", { path, content }),
	};
}

function nativeAgent(record: CreatedFiles, cwd = ws): Agent {
	const call = (name: "run_command" | "write_file", input: Record<string, unknown>) => {
		setToolContext({ workingDirectory: cwd, createdFiles: record });
		return (
			agentTools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
		).execute(input, { toolCallId: "born", messages: [] });
	};
	return {
		run: (command) => call("run_command", { command }),
		write: (path, content) => call("write_file", { path, content }),
	};
}

async function build(agent: Agent, script = BUILD): Promise<void> {
	await agent.write("video/build_slides.sh", script);
	await agent.run("bash video/build_slides.sh");
	expect(existsSync(join(ws, "video", "body_1-0.png"))).toBe(true);
}

function expectJudgedAndBlocked(out: string, ...stillThere: string[]) {
	expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
	expect(judge.rmAsks).toBe(1);
	for (const f of stillThere) expect(existsSync(join(ws, f))).toBe(true);
}

describe.skipIf(!HAS_BIRTH || !POSIX)("(1) the tt-48 case passes without the judge", () => {
	test("ToolExecutor: bash video/build_slides.sh, then the pilot's rm", async () => {
		const ex = new ToolExecutor(ws, "born-a");
		const agent = executorAgent(ex);
		await build(agent);
		expect(ex.createdFiles.createdBySession(join(ws, "video", "body_1-0.png"))).toBe(true);
		const out = await agent.run(PILOT_RM);
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "video", "body_1-0.png"))).toBe(false);
		expect(existsSync(join(ws, "video", "body_1-1.png"))).toBe(false);
		expect(existsSync(join(ws, "video", "slide_1.png"))).toBe(true);
		expect(judge.rmAsks).toBe(0);
	});

	test("AI SDK native run_command: the same", async () => {
		const agent = nativeAgent(new CreatedFiles());
		await build(agent);
		const out = await agent.run(PILOT_RM);
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "video", "body_1-0.png"))).toBe(false);
		expect(judge.rmAsks).toBe(0);
	});
});

describe("(2) the same command on files the session did not write goes to the judge", () => {
	test("written by something else before the session", async () => {
		writeFileSync(join(ws, "video", "body_1-0.png"), "x");
		writeFileSync(join(ws, "video", "body_1-1.png"), "x");
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		expectJudgedAndBlocked(await agent.run(PILOT_RM), "video/body_1-0.png", "video/body_1-1.png");
	});

	test.skipIf(!HAS_BIRTH || !POSIX)(
		"one of the two the session wrote, one it did not",
		async () => {
			const agent = executorAgent(new ToolExecutor(ws, "born-a"));
			await build(agent, BUILD.replace("printf 'png1' > body_1-1.png\n", ""));
			writeFileSync(join(ws, "video", "body_1-1.png"), "x");
			expectJudgedAndBlocked(await agent.run(PILOT_RM), "video/body_1-0.png", "video/body_1-1.png");
		},
	);
});

describe.skipIf(!HAS_BIRTH || !POSIX)("(3) every other shape keeps the existing path", () => {
	test("rm -rf video", async () => {
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		await build(agent);
		expectJudgedAndBlocked(await agent.run("rm -rf video"), "video/body_1-0.png");
	});

	test("a wildcard: rm video/*.png", async () => {
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		await build(agent);
		expectJudgedAndBlocked(await agent.run("rm video/*.png"), "video/body_1-0.png");
	});

	test("a path outside the project: rm ../x.png", async () => {
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		await build(agent, `${BUILD}printf 'x' > ../../${outside.split("/").pop()}/x.png\n`);
		const out = await agent.run(`rm -f ../${outside.split("/").pop()}/x.png`);
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.rmAsks).toBe(1);
		expect(existsSync(join(outside, "x.png"))).toBe(true);
	});

	test("a symlink operand the command created", async () => {
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		await build(agent, `${BUILD}ln -s body_1-0.png link.png\n`);
		expectJudgedAndBlocked(await agent.run("rm -f video/link.png"), "video/link.png");
	});

	test("a protected path: a key file under the project's .8gent/keys the session wrote", async () => {
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		await agent.write(".8gent/keys/k.txt", "key\n");
		expect(existsSync(join(ws, ".8gent", "keys", "k.txt"))).toBe(true);
		expectJudgedAndBlocked(await agent.run("rm -f .8gent/keys/k.txt"), ".8gent/keys/k.txt");
	});

	test("an existing file the command replaced by rename keeps its path: not the session's", async () => {
		writeFileSync(join(ws, "video", "keep.png"), "mine");
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		await build(agent, `${BUILD}cat keep.png > t.tmp\nmv t.tmp keep.png\n`);
		expectJudgedAndBlocked(await agent.run("rm -f video/keep.png"), "video/keep.png");
	});

	test("a hard link to an older file keeps the old birth time: not the session's", async () => {
		writeFileSync(join(outside, "old.png"), "old");
		await new Promise((r) => setTimeout(r, 1100));
		const agent = executorAgent(new ToolExecutor(ws, "born-a"));
		await build(agent, `${BUILD}ln ${join(outside, "old.png")} linked.png\n`);
		expectJudgedAndBlocked(await agent.run("rm -f video/linked.png"), "video/linked.png");
	});
});

describe.skipIf(!HAS_BIRTH || !POSIX)("(4) another session or another project", () => {
	test("files another session's command wrote go to the judge", async () => {
		await build(executorAgent(new ToolExecutor(ws, "born-a")));
		const other = executorAgent(new ToolExecutor(ws, "born-b"));
		expectJudgedAndBlocked(await other.run(PILOT_RM), "video/body_1-0.png", "video/body_1-1.png");
	});

	test("the record from one project does not cover the same name in another", async () => {
		const record = new CreatedFiles();
		await build(nativeAgent(record));
		mkdirSync(join(outside, "video"));
		writeFileSync(join(outside, "video", "body_1-0.png"), "x");
		writeFileSync(join(outside, "video", "body_1-1.png"), "x");
		expect(rmOfNothingOrOwn(PILOT_RM, outside, record)).toBeNull();
		expect(rmOfNothingOrOwn(PILOT_RM, ws, record)).toBe("own-scratch");
	});
});

describe.skipIf(!HAS_BIRTH)("watchBorn: the walk before the command must be complete", () => {
	test("a small tree: a file born during the command is recorded", () => {
		const root = realpathSync(ws);
		const record = new CreatedFiles();
		const done = watchBorn(root, record);
		writeFileSync(join(root, "video", "new.png"), "x");
		done();
		expect(record.createdBySession(join(root, "video", "new.png"))).toBe(true);
	});

	test("a tree past the entry limit records nothing", () => {
		const root = realpathSync(ws);
		mkdirSync(join(root, "many"));
		for (let i = 0; i < 3001; i++) writeFileSync(join(root, "many", `f${i}`), "");
		const record = new CreatedFiles();
		const done = watchBorn(root, record);
		writeFileSync(join(root, "video", "new.png"), "x");
		done();
		expect(record.size).toBe(0);
	});
});
