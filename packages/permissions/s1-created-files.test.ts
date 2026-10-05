/**
 * #3177: an agent may rm the scratch files it created itself, without the
 * judge. Extends #3168 (rm of nothing).
 *
 * The judge is a stub that calls every `rm` dangerous and everything else
 * safe, so the pilot's `bun test > bunout.txt 2>&1` runs (as it does with
 * Selene) and any rm that reaches the judge is blocked. A rm the new rule
 * passes never reaches it (`judge.rmAsks` stays 0); every negative must.
 *
 * All through the REAL tool entry points: ToolExecutor.execute (text-tool
 * loop) and agentTools (native loop), with the flag on as the pilot runs it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { CreatedFiles, redirectTargets, watchRedirects } from "./s1-created-files";
import { rmOfNothingOrOwn } from "./s1-rm-nothing";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
} from "./system-one-gate";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

// Remove the temp dirs tempDir() has recorded, this file's included (#3285).
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

let ws: string;
let outside: string;
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
	ws = tempDir("s1-own-ws-");
	outside = tempDir("s1-own-out-");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	writeFileSync(join(ws, "notes.md"), "tracked");
	execFileSync("git", ["add", "notes.md"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], {
		cwd: ws,
	});
	// A symlinked directory inside the workspace that points outside it.
	symlinkSync(outside, join(ws, "escape"));
	judge = new RmIsDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-own-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

const run = (ex: ToolExecutor, command: string) => ex.execute("run_command", { command });
const write = (ex: ToolExecutor, path: string) =>
	ex.execute("write_file", { path, content: "scratch\n" });

/** A native-loop agent: its own tool context with its own record. */
function nativeAgent(record: CreatedFiles) {
	const call = (name: "run_command" | "write_file", input: Record<string, unknown>) => {
		setToolContext({ workingDirectory: ws, createdFiles: record });
		return (
			agentTools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
		).execute(input, { toolCallId: "own", messages: [] });
	};
	return {
		run: (command: string) => call("run_command", { command }),
		write: (path: string) => call("write_file", { path, content: "scratch\n" }),
	};
}

describe("redirectTargets", () => {
	test("plain relative targets of > and >>, the pilot's form included", () => {
		expect(redirectTargets("bun test > bunout.txt 2>&1")).toEqual(["bunout.txt"]);
		expect(redirectTargets("echo a >> log/run.txt")).toEqual(["log/run.txt"]);
		expect(redirectTargets("cmd &> all.txt")).toEqual(["all.txt"]);
		expect(redirectTargets("cmd 2> err.txt >out.txt")).toEqual(["err.txt", "out.txt"]);
	});

	test("never a quoted, absolute, parent, variable or glob target", () => {
		for (const c of [
			"echo 'a > b.txt'",
			'echo x > "q.txt"',
			"echo x > /tmp/abs.txt",
			"echo x > ../up.txt",
			"echo x > $HOME/v.txt",
			"echo x > ~/t.txt",
			"echo x > out*.txt",
			"echo x 2>&1",
			"echo x > /dev/null",
		]) {
			expect(redirectTargets(c)).toEqual([]);
		}
	});
});

/**
 * The pilot approves cards (onApproval "approve"), so these run interactive,
 * as in the TUI: the permission layer still draws its card for a dangerous rm
 * and the person approves it. What changes is System One: the judge is never
 * asked, so the only card is the permission layer's, and the file is gone.
 */
describe("the pilot case, both tool paths", () => {
	let cards: string[];
	let ttyWas: PropertyDescriptor | undefined;

	beforeEach(() => {
		cards = [];
		registerTuiApprovalHandler(async (req) => {
			cards.push(req.command ?? "");
			return "approve";
		});
		Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		registerTuiApprovalHandler(null);
		if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		process.env.EIGHT_HEADLESS = "1";
	});

	/** At most the permission layer's own card for the rm; never a System One card. */
	const onlyPermissionCards = (rm: string) => {
		for (const c of cards) expect(c).toBe(rm);
	};

	test("ToolExecutor: bun test > bunout.txt 2>&1, then rm -f bunout.txt, without the judge", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "bun test > bunout.txt 2>&1");
		expect(existsSync(join(ws, "bunout.txt"))).toBe(true);
		expect(ex.createdFiles.size).toBe(1);
		const out = await run(ex, "rm -f bunout.txt");
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "bunout.txt"))).toBe(false);
		expect(judge.rmAsks).toBe(0);
		onlyPermissionCards("rm -f bunout.txt");
	});

	test("AI SDK: the same, through the native run_command", async () => {
		const agent = nativeAgent(new CreatedFiles());
		await agent.run("bun test > bunout.txt 2>&1");
		expect(existsSync(join(ws, "bunout.txt"))).toBe(true);
		const out = await agent.run("rm -f bunout.txt");
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "bunout.txt"))).toBe(false);
		expect(judge.rmAsks).toBe(0);
		onlyPermissionCards("rm -f bunout.txt");
	});

	test("an ordinary redirect still counts: echo x > out.txt, then >>, then rm -f out.txt", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > out.txt");
		await run(ex, "echo y >> out.txt");
		expect(readFileSync(join(ws, "out.txt"), "utf8")).toBe("x\ny\n");
		expect(ex.createdFiles.createdBySession(join(ws, "out.txt"))).toBe(true);
		const out = await run(ex, "rm -f out.txt");
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "out.txt"))).toBe(false);
		expect(judge.rmAsks).toBe(0);
		onlyPermissionCards("rm -f out.txt");
	});

	test("write_file creating a file counts too, on both paths, and mixes with absent paths", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await write(ex, "scratch/a.txt");
		const agent = nativeAgent(ex.createdFiles);
		await agent.write("b.txt");
		const rm = "rm -f scratch/a.txt b.txt never-was.txt";
		const out = await run(ex, rm);
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "scratch", "a.txt"))).toBe(false);
		expect(existsSync(join(ws, "b.txt"))).toBe(false);
		expect(judge.rmAsks).toBe(0);
		onlyPermissionCards(rm);
	});
});

describe("everything else still goes to the judge", () => {
	/** Run `rm` and require: the judge was asked, it blocked, the file survives. */
	async function judged(ex: ToolExecutor, command: string, survivor: string) {
		const before = judge.rmAsks;
		const out = await run(ex, command);
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.rmAsks).toBe(before + 1);
		expect(existsSync(join(ws, survivor))).toBe(true);
	}

	test("a tracked file, even one this session created", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > made.txt");
		execFileSync("git", ["add", "made.txt"], { cwd: ws });
		await judged(ex, "rm -f made.txt", "made.txt");
		await judged(ex, "rm -f notes.md", "notes.md");
	});

	test("a pre-existing untracked file", async () => {
		writeFileSync(join(ws, "old.log"), "pre-existing");
		const ex = new ToolExecutor(ws, "own-a");
		await judged(ex, "rm -f old.log", "old.log");
	});

	test("a file this session modified but did not create (redirect and write_file)", async () => {
		writeFileSync(join(ws, "old.log"), "pre-existing");
		writeFileSync(join(ws, "old2.log"), "pre-existing");
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > old.log");
		await write(ex, "old2.log");
		expect(ex.createdFiles.size).toBe(0);
		await judged(ex, "rm -f old.log", "old.log");
		await judged(ex, "rm -f old2.log", "old2.log");
	});

	test("a file another session (tab) created", async () => {
		const tabA = new ToolExecutor(ws, "tab-a");
		const tabB = new ToolExecutor(ws, "tab-b");
		await run(tabA, "echo x > a-made.txt");
		await judged(tabB, "rm -f a-made.txt", "a-made.txt");
		// Native loop: another agent's context has another record.
		const other = nativeAgent(new CreatedFiles());
		const out = await other.run("rm -f a-made.txt");
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "a-made.txt"))).toBe(true);
	});

	test("rm -r, and a glob, of files this session created", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > bunout.txt");
		await judged(ex, "rm -rf bunout.txt", "bunout.txt");
		await judged(ex, "rm -f bun*.txt", "bunout.txt");
	});

	test("a created file behind a symlink that leads out of the workspace", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > escape/f.txt");
		expect(existsSync(join(outside, "f.txt"))).toBe(true);
		await judged(ex, "rm -f escape/f.txt", "escape/f.txt");
	});

	test("a created file that was since replaced by someone else is no longer this session's", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > made.txt");
		unlinkSync(join(ws, "made.txt"));
		writeFileSync(join(ws, "made.txt"), "someone else's");
		await judged(ex, "rm -f made.txt", "made.txt");
	});
});

/**
 * 8SO (2026-10-05): a redirect target is recorded only when it is still the
 * inode the shell opened. `mv user-file target > target` creates the target,
 * then renames the user's file over it; `zip -qm - user-file > out.zip` fills
 * the target with the user's file and deletes the original. Either way a
 * later `rm -f target` would have removed the user's only copy without the
 * judge. All files here are scratch, in this test's own workspace.
 */
describe("laundering a user's file through a redirect target is judged", () => {
	/** Run `rm` and require: the judge was asked, it blocked, the file survives. */
	async function judged(rmRun: (c: string) => Promise<string>, command: string, survivor: string) {
		const before = judge.rmAsks;
		const out = await rmRun(command);
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.rmAsks).toBe(before + 1);
		expect(existsSync(join(ws, survivor))).toBe(true);
	}
	const userFile = () => writeFileSync(join(ws, "user.txt"), "the user's only copy");

	test("PoC: mv user.txt out.txt > out.txt, then rm -f out.txt (ToolExecutor)", async () => {
		userFile();
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "mv user.txt out.txt > out.txt");
		expect(existsSync(join(ws, "user.txt"))).toBe(false);
		expect(readFileSync(join(ws, "out.txt"), "utf8")).toBe("the user's only copy");
		expect(ex.createdFiles.size).toBe(0);
		await judged((c) => run(ex, c), "rm -f out.txt", "out.txt");
	});

	test("PoC: the same through the native run_command", async () => {
		userFile();
		const agent = nativeAgent(new CreatedFiles());
		await agent.run("mv user.txt out.txt > out.txt");
		expect(existsSync(join(ws, "user.txt"))).toBe(false);
		await judged(agent.run, "rm -f out.txt", "out.txt");
	});

	test("a recorded target replaced by a later redirect command is forgotten", async () => {
		userFile();
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > out.txt");
		expect(ex.createdFiles.createdBySession(join(ws, "out.txt"))).toBe(true);
		await run(ex, "mv user.txt out.txt >> out.txt");
		expect(readFileSync(join(ws, "out.txt"), "utf8")).toBe("the user's only copy");
		expect(ex.createdFiles.size).toBe(0);
		await judged((c) => run(ex, c), "rm -f out.txt", "out.txt");
	});

	test("PoC: zip -qm - user.txt > out.zip escalates; even approved, rm -f out.zip is judged", async () => {
		userFile();
		const ex = new ToolExecutor(ws, "own-a");
		// Unapproved, archive_removes_source escalates and the zip never runs.
		expect(await run(ex, "zip -qm - user.txt > out.zip")).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "user.txt"))).toBe(true);
		// The worst case: a person approves it, so the zip runs.
		const approved: string[] = [];
		_setSystemOneOverridesForTests({
			createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
			askHuman: async (req) => {
				if (req.command.startsWith("zip ")) {
					approved.push(req.command);
					return true;
				}
				return null;
			},
			calibrationDir: tempDir("s1-own-nocal-"),
		});
		await run(ex, "zip -qm - user.txt > out.zip");
		expect(approved).toEqual(["zip -qm - user.txt > out.zip"]);
		expect(existsSync(join(ws, "user.txt"))).toBe(false);
		expect(existsSync(join(ws, "out.zip"))).toBe(true);
		expect(ex.createdFiles.size).toBe(0);
		await judged((c) => run(ex, c), "rm -f out.zip", "out.zip");
	});
});

describe("watchRedirects: pinning", () => {
	test("an absent target is created empty before the command and recorded after", () => {
		const rec = new CreatedFiles();
		const done = watchRedirects("echo x > made.txt", ws, rec);
		expect(readFileSync(join(ws, "made.txt"), "utf8")).toBe("");
		execFileSync("sh", ["-c", "echo x > made.txt"], { cwd: ws });
		done();
		expect(rec.createdBySession(join(ws, "made.txt"))).toBe(true);
	});

	test("a target replaced by a rename while the command runs is not recorded", () => {
		writeFileSync(join(ws, "user.txt"), "user");
		const rec = new CreatedFiles();
		const done = watchRedirects("mv user.txt made.txt > made.txt", ws, rec);
		execFileSync("sh", ["-c", "mv user.txt made.txt > made.txt"], { cwd: ws });
		done();
		expect(rec.size).toBe(0);
	});

	test("a target that already existed is neither touched nor recorded", () => {
		writeFileSync(join(ws, "old.log"), "pre-existing");
		const rec = new CreatedFiles();
		const done = watchRedirects("echo x > old.log", ws, rec);
		expect(readFileSync(join(ws, "old.log"), "utf8")).toBe("pre-existing");
		done();
		expect(rec.size).toBe(0);
	});

	test("a command that changes directory, or that any rule escalates, records and creates nothing", () => {
		const rec = new CreatedFiles();
		for (const c of ["cd escape && echo x > cd.txt", "zip -qm - notes.md > z.zip"]) {
			const done = watchRedirects(c, ws, rec);
			done();
		}
		expect(existsSync(join(ws, "cd.txt"))).toBe(false);
		expect(existsSync(join(ws, "z.zip"))).toBe(false);
		expect(rec.size).toBe(0);
	});

	test("a target in a directory that does not exist yet is not created or recorded", () => {
		const rec = new CreatedFiles();
		const done = watchRedirects("echo x > newdir/f.txt", ws, rec);
		expect(existsSync(join(ws, "newdir"))).toBe(false);
		done();
		expect(rec.size).toBe(0);
	});
});

describe("identity: the same file, not just the same inode", () => {
	test("the session's own edit_file keeps it the session's; a change from outside does not", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await write(ex, "made.txt");
		await ex.execute("edit_file", { path: "made.txt", oldText: "scratch", newText: "edited" });
		expect(readFileSync(join(ws, "made.txt"), "utf8")).toBe("edited\n");
		expect(ex.createdFiles.createdBySession(join(ws, "made.txt"))).toBe(true);
		writeFileSync(join(ws, "made.txt"), "changed by someone else, longer");
		expect(ex.createdFiles.createdBySession(join(ws, "made.txt"))).toBe(false);
	});
});

describe("rmOfNothingOrOwn", () => {
	test("absent only is 'nothing'; with an own file it is 'own-scratch'; no record keeps today's answer", async () => {
		const ex = new ToolExecutor(ws, "own-a");
		await run(ex, "echo x > made.txt");
		expect(rmOfNothingOrOwn("rm -f gone.txt", ws, ex.createdFiles)).toBe("nothing");
		expect(rmOfNothingOrOwn("rm -f made.txt gone.txt", ws, ex.createdFiles)).toBe("own-scratch");
		expect(rmOfNothingOrOwn("rm -f made.txt", ws)).toBeNull();
		expect(rmOfNothingOrOwn("rm -f made.txt", ws, new CreatedFiles())).toBeNull();
	});
});
