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
 *
 * Residual (documented in s1-created-files.ts): a NEW file another process
 * creates inside a directory the command named, while the command runs, is
 * recorded as this session's. Section (5) pins the boundary: a new file
 * outside every directory the command named is never recorded.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { CreatedFiles, bornScopes, watchBorn } from "./s1-created-files";
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

/** Another process writes `rel` under ws after `ms`; resolves once it has. */
function otherProcessWrites(rel: string, ms: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", `sleep ${ms / 1000}; printf other > ${rel}`], { cwd: ws });
		child.on("error", reject);
		child.on("exit", () => resolve());
	});
}

describe.skipIf(!HAS_BIRTH || !POSIX)(
	"(5) new files outside the directories the command named go to the judge",
	() => {
		test("a session's `sleep` while another process creates notes.md in the project root", async () => {
			const ex = new ToolExecutor(ws, "born-a");
			const session = executorAgent(ex);
			await Promise.all([session.run("sleep 1"), otherProcessWrites("notes.md", 300)]);
			expect(existsSync(join(ws, "notes.md"))).toBe(true);
			expect(ex.createdFiles.createdBySession(join(ws, "notes.md"))).toBe(false);
			expectJudgedAndBlocked(await session.run("rm -f notes.md"), "notes.md");
		});

		test("session A's `sleep` while session B writes video/b-report.md: A's rm goes to the judge", async () => {
			const a = new ToolExecutor(ws, "born-a");
			const b = executorAgent(new ToolExecutor(ws, "born-b"));
			const later = new Promise((r) => setTimeout(r, 300)).then(() =>
				b.write("video/b-report.md", "b\n"),
			);
			await Promise.all([executorAgent(a).run("sleep 1"), later]);
			expect(existsSync(join(ws, "video", "b-report.md"))).toBe(true);
			expect(a.createdFiles.createdBySession(join(ws, "video", "b-report.md"))).toBe(false);
			expectJudgedAndBlocked(
				await executorAgent(a).run("rm -f video/b-report.md"),
				"video/b-report.md",
			);
		});
	},
);

describe.skipIf(!HAS_BIRTH || !POSIX)(
	"(6) a credential name the command wrote is recorded, yet judged",
	() => {
		for (const name of ["id_rsa", "credentials"]) {
			test(`video/${name}, written by a child of a command that names video/`, async () => {
				const ex = new ToolExecutor(ws, "born-a");
				const session = executorAgent(ex);
				// The name comes in as an argument: a script that names a key file outright is now
				// stopped by the rules reading its body, before anything is recorded.
				await session.write(
					"video/mk.sh",
					'#!/usr/bin/env bash\ncd "$(dirname "$0")"\nprintf k > "$1"\n',
				);
				await session.run(`bash video/mk.sh ${name}`);
				// Recorded: only the write refusal in rmOfNothingOrOwn stands between it and the lane.
				expect(ex.createdFiles.createdBySession(join(ws, "video", name))).toBe(true);
				expectJudgedAndBlocked(await session.run(`rm -f video/${name}`), `video/${name}`);
			});
		}
	},
);

describe("bornScopes: only the directories a command names", () => {
	const scopes = (command: string) => {
		const root = realpathSync(ws);
		// Slash-separated on every platform: the scopes are compared as text.
		return bornScopes(command, root).map((d) =>
			d
				.slice(root.length + 1)
				.split(sep)
				.join("/"),
		);
	};

	test("a script path scopes to its directory; a directory to itself", () => {
		mkdirSync(join(ws, "video", "out"));
		writeFileSync(join(ws, "video", "build_slides.sh"), "");
		expect(scopes("bash video/build_slides.sh")).toEqual(["video"]);
		expect(scopes("ls video/out")).toEqual(["video/out"]);
		expect(scopes("convert x.png video/out/new.png")).toEqual(["video/out"]);
	});

	test("commands naming no directory below the root walk nothing", () => {
		writeFileSync(join(ws, "Makefile"), "");
		for (const c of ["make", "sleep 30", "ls", "ls .", "cat Makefile", "touch new.txt"])
			expect(scopes(c)).toEqual([]);
	});

	test("quoted, `..`, `$`, `~`, glob, absolute, flag and dot words are never scopes", () => {
		mkdirSync(join(ws, ".hidden"));
		mkdirSync(join(ws, "node_modules"));
		for (const c of [
			'bash "video/build_slides.sh"',
			"ls ../video",
			"ls video/../video",
			"ls $HOME/video",
			"ls ~/video",
			"ls video/*",
			`ls ${join(realpathSync(ws), "video")}`,
			"ls --dir=video",
			"ls .hidden",
			"ls .git",
			"ls node_modules",
		])
			expect(scopes(c)).toEqual([]);
	});

	test("a symlink resolving outside the project is not a scope", () => {
		symlinkSync(outside, join(ws, "away"));
		expect(scopes("ls away/x")).toEqual([]);
	});

	test("a word through a symlink out of the project, or into a dot directory, is not a scope", () => {
		symlinkSync(outside, join(ws, "linkout"));
		mkdirSync(join(ws, ".8gent"));
		symlinkSync(".8gent", join(ws, "hid"));
		expect(scopes("touch linkout/x")).toEqual([]);
		expect(scopes("touch hid/x")).toEqual([]);
	});

	test("a dot word is not a scope, even when it resolves to a plain directory", () => {
		mkdirSync(join(ws, ".cache"));
		symlinkSync("video", join(ws, ".vid"));
		expect(scopes("bash x.sh .cache/t.bin")).toEqual([]);
		expect(scopes("bash x.sh .vid/t.bin")).toEqual([]);
	});

	test("nested scopes collapse, and at most four are kept", () => {
		for (const d of ["a", "b", "c", "d", "e"]) mkdirSync(join(ws, d));
		mkdirSync(join(ws, "a", "inner"));
		expect(scopes("ls a/inner a")).toEqual(["a"]);
		expect(scopes("ls a b c d e")).toEqual(["a", "b", "c", "d"]);
	});
});

describe.skipIf(!HAS_BIRTH)(
	"watchBorn: each scope's walk before the command must be complete",
	() => {
		test("a small scope: a file born in it during the command is recorded", () => {
			const root = realpathSync(ws);
			const record = new CreatedFiles();
			const done = watchBorn("bash video/build_slides.sh", root, record);
			writeFileSync(join(root, "video", "new.png"), "x");
			done();
			expect(record.createdBySession(join(root, "video", "new.png"))).toBe(true);
		});

		test("a file born outside the named scope is not recorded", () => {
			const root = realpathSync(ws);
			mkdirSync(join(root, "other"));
			const record = new CreatedFiles();
			const done = watchBorn("bash video/build_slides.sh", root, record);
			writeFileSync(join(root, "other", "new.png"), "x");
			writeFileSync(join(root, "new.png"), "x");
			done();
			expect(record.size).toBe(0);
		});

		test("a scope past the entry limit records nothing", () => {
			const root = realpathSync(ws);
			mkdirSync(join(root, "video", "many"));
			for (let i = 0; i < 3001; i++) writeFileSync(join(root, "video", "many", `f${i}`), "");
			const record = new CreatedFiles();
			const done = watchBorn("bash video/build_slides.sh", root, record);
			writeFileSync(join(root, "video", "new.png"), "x");
			done();
			expect(record.size).toBe(0);
		});

		test("files the incomplete walk before never listed are not recorded when the walk after completes", async () => {
			const root = realpathSync(ws);
			// Start at a second boundary so every file below is born inside the command's window,
			// leaving only the walk-before-was-complete check to turn them away.
			while (Date.now() % 1000 > 50) await new Promise((r) => setTimeout(r, 5));
			for (const d of ["a", "b"]) {
				mkdirSync(join(root, "video", d));
				for (let i = 0; i < 1600; i++) writeFileSync(join(root, "video", d, `f${i}`), "");
			}
			const record = new CreatedFiles();
			const done = watchBorn("bash video/build_slides.sh", root, record);
			for (const d of ["a", "b"])
				for (let i = 0; i < 400; i++) rmSync(join(root, "video", d, `f${i}`));
			done();
			expect(record.size).toBe(0);
		});

		test("a scope swapped for a symlink out of the project during the command records nothing", () => {
			const root = realpathSync(ws);
			writeFileSync(join(root, "video", "swap.sh"), "");
			const record = new CreatedFiles();
			const done = watchBorn("bash video/swap.sh", root, record);
			// What a command that swaps its scope for a link out of the project does, done in
			// process so it needs no POSIX shell (Git Bash's `ln -s` copies on Windows).
			renameSync(join(root, "video"), join(root, "video.old"));
			symlinkSync(outside, join(root, "video"));
			writeFileSync(join(outside, "f.png"), "x");
			done();
			expect(existsSync(join(outside, "f.png"))).toBe(true);
			expect(record.createdBySession(join(outside, "f.png"))).toBe(false);
			expect(record.size).toBe(0);
		});

		test("a large sibling outside the scope no longer blocks recording", () => {
			const root = realpathSync(ws);
			mkdirSync(join(root, "many"));
			for (let i = 0; i < 3001; i++) writeFileSync(join(root, "many", `f${i}`), "");
			const record = new CreatedFiles();
			const done = watchBorn("bash video/build_slides.sh", root, record);
			writeFileSync(join(root, "video", "new.png"), "x");
			done();
			expect(record.createdBySession(join(root, "video", "new.png"))).toBe(true);
		});
	},
);
