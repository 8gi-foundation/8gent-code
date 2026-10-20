/**
 * #4105: System One must take `rm -rf build` without the judge when `build` is
 * a plain relative directory this session made with a mkdir-only run_command,
 * and must pass nothing else. The judge here says "dangerous" to everything,
 * so any command that reaches it is blocked; a negative must never be the
 * allowlist. The record is filled the way both tool paths fill it: through
 * watchRedirects around the real shell command.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { CreatedFiles, mkdirRecorded, watchRedirects } from "./s1-created-files";
import { rmOwnDir } from "./s1-rm-own-dir";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

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

/** The exact commands from the pilot session (run 2026-10-12_194129, seq 116 and 168). */
const PILOT_MKDIR = "mkdir -p build";
const PILOT_RM = "rm -rf build";
/** The pilot's write (seq 120): `TODO_FILE=build/todos.json bun src/cli.ts add ...`, the CLI as a script. */
const PILOT_WRITE = "TODO_FILE=build/todos.json sh tools/w.sh";

let ws: string;
let outside: string;
let rec: CreatedFiles;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});
afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

/** Run `cmd` in the workspace the way run_command does, with the record watching. */
function sh(cmd: string, record = rec) {
	const done = watchRedirects(cmd, ws, record);
	try {
		execFileSync("sh", ["-c", cmd], { cwd: ws, stdio: "ignore" });
	} catch {
		// A failing command still finishes the watch.
	}
	done();
}

function put(rel: string, body = "x") {
	mkdirSync(join(ws, rel, ".."), { recursive: true });
	writeFileSync(join(ws, rel), body);
}

const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd: ws,
		stdio: "ignore",
	});

// The lane reads POSIX shell text and is off on win32 (the rm/mv lanes are POSIX-only there too).
describe.skipIf(process.platform === "win32")(
	"#4105 rm -r of a directory this session made",
	() => {
		beforeEach(() => {
			ws = tempDir("s1-owndir-ws-");
			outside = tempDir("s1-owndir-out-");
			git("init", "-q");
			put("src/app.ts", "export {};");
			put("dist/keep.txt");
			// The pilot's CLI writes the file its TODO_FILE names; this stands in for it.
			put("tools/w.sh", 'echo [] > "$TODO_FILE"\n');
			git("add", "src/app.ts", "dist/keep.txt", "tools/w.sh");
			git("commit", "-qm", "init");
			// Before the session: a directory with a file in it, a dot directory, a link out.
			put("old/note.txt");
			mkdirSync(join(ws, ".cache"));
			symlinkSync(outside, join(ws, "escape"));
			Bun.sleepSync(20);
			rec = new CreatedFiles();
			// The pilot: mkdir -p build, then the CLI (a child of the command) writes build/todos.json.
			sh(PILOT_MKDIR);
			sh(PILOT_WRITE);
			sh("mkdir real");
			symlinkSync(join(ws, "real"), join(ws, "alias"));
			judge = new AlwaysDangerous();
			_setSystemOneOverridesForTests({
				createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
				askHuman: async () => null,
				calibrationDir: tempDir("s1-owndir-nocal-"),
			});
		});

		afterEach(() => {
			rmSync(ws, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
			Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
			Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
		});

		const ok = (c: string, record: CreatedFiles | undefined = rec) => rmOwnDir(c, ws, record).ok;

		describe("the record", () => {
			test("mkdir -p build records build", () => {
				expect(rec.createdDirBySession(join(ws, "build"))).toBe(true);
			});
			test("mkdir -p a/b records both a and a/b", () => {
				sh("mkdir -p a/b");
				expect(rec.createdDirBySession(join(ws, "a"))).toBe(true);
				expect(rec.createdDirBySession(join(ws, "a/b"))).toBe(true);
			});
			test("an older directory renamed onto the path while mkdir runs is not recorded (8SO, #4106)", () => {
				put("prior/note.txt");
				Bun.sleepSync(1100);
				// The window: the watch starts, then something else renames an older directory onto
				// `win` before the mkdir would have made it.
				const done = watchRedirects("mkdir -p win", ws, rec);
				renameSync(join(ws, "prior"), join(ws, "win"));
				done();
				expect(rec.createdDirBySession(join(ws, "win"))).toBe(false);
				put("win/later.txt");
				expect(rmOwnDir("rm -rf win", ws, rec).ok).toBe(false);
			});
			test("a file the command's child writes where a NAME=path word points is recorded (#4160 scopes)", () => {
				expect(rec.bornToSession(join(ws, "build/todos.json"))).toBe(true);
			});
			test("rewritten in place, it is still the session's; replaced by a new file, it is not", () => {
				sh("TODO_FILE=build/todos.json sh tools/w.sh");
				expect(rec.bornToSession(join(ws, "build/todos.json"))).toBe(true);
				put("build/new.json", "[]");
				renameSync(join(ws, "build/new.json"), join(ws, "build/todos.json"));
				expect(rec.bornToSession(join(ws, "build/todos.json"))).toBe(false);
			});
			test("a directory that existed before is never recorded", () => {
				sh("mkdir -p old");
				expect(rec.createdDirBySession(join(ws, "old"))).toBe(false);
			});
			test("only a mkdir-only command records", () => {
				for (const [cmd, dir] of [
					["mkdir c1 && touch x", "c1"],
					["mkdir c2; true", "c2"],
					["mkdir -m 777 c3", "c3"],
					["mkdir c4 > log", "c4"],
					[`mkdir ${join(ws, "c5")}`, "c5"],
					["mkdir ../c6x", "c6x"],
					["cp -r old c7", "c7"],
					["mkdir 'c8'", "c8"],
				]) {
					sh(cmd);
					expect(rec.createdDirBySession(join(ws, dir)), cmd).toBe(false);
				}
				rmSync(join(ws, "..", "c6x"), { recursive: true, force: true });
			});
		});

		describe("rmOwnDir allows", () => {
			test("the pilot's exact command", () => {
				const r = rmOwnDir(PILOT_RM, ws, rec);
				expect(r).toEqual({
					ok: true,
					reason:
						"rm -r of directories this session made (build): untracked, only the session's own files inside",
				});
			});
			test("the other spellings of a recursive rm", () => {
				for (const c of [
					"rm -r build",
					"rm -R build",
					"rm -rf build/",
					"rm -r -f build",
					"rm -rfv build",
				])
					expect(ok(c), c).toBe(true);
			});
			test("nested and several directories, all made by the session", () => {
				sh("mkdir -p out/tmp");
				expect(ok("rm -rf out")).toBe(true);
				expect(ok("rm -rf out/tmp")).toBe(true);
				expect(ok("rm -rf build out real")).toBe(true);
			});
			test("the session's file rewritten in place by a later run of its own CLI", () => {
				sh(PILOT_WRITE);
				expect(ok(PILOT_RM)).toBe(true);
			});
			test("the command then does what it says: build is gone, the rest stays", () => {
				execFileSync("sh", ["-c", PILOT_RM], { cwd: ws });
				expect(existsSync(join(ws, "build"))).toBe(false);
				expect(existsSync(join(ws, "src/app.ts"))).toBe(true);
			});
		});

		describe("rmOwnDir refuses", () => {
			const refused: Array<[string, string]> = [
				["absolute path", "rm -rf WS/build"],
				["absolute path outside", "rm -rf OUTSIDE"],
				["parent", "rm -rf ../build"],
				["parent at the end", "rm -rf build/.."],
				["parent in the middle", "rm -rf build/../old"],
				["tilde", "rm -rf ~/build"],
				["glob star", "rm -rf buil*"],
				["glob question mark", "rm -rf buil?"],
				["brace list", "rm -rf {build,old}"],
				["double quotes", 'rm -rf "build"'],
				["single quotes", "rm -rf 'build'"],
				["variable", "rm -rf $DIR"],
				["substitution", "rm -rf $(echo build)"],
				["backtick", "rm -rf `echo build`"],
				["symlink to a session directory", "rm -rf alias"],
				["symlink out of the workspace", "rm -rf escape"],
				["through a symlinked directory", "rm -rf alias/."],
				["a directory that existed before the session", "rm -rf old"],
				["a tracked directory", "rm -rf dist"],
				["tracked source", "rm -rf src"],
				["a second target that is the parent", "rm -rf build .."],
				["a second target that existed before", "rm -rf build old"],
				["no-preserve-root on /", "rm -rf --no-preserve-root /"],
				["root", "rm -rf /"],
				["workspace root", "rm -rf ."],
				["dot slash", "rm -rf ./build"],
				["dot at the end", "rm -rf build/."],
				["a dot directory", "rm -rf .cache"],
				["the git directory", "rm -rf .git"],
				["semicolon", "rm -rf build; cat x"],
				["and-chain", "rm -rf build && ls"],
				["or-chain", "rm -rf build || ls"],
				["pipe", "rm -rf build | cat"],
				["redirect", "rm -rf build > log"],
				["background", "rm -rf build &"],
				["comment", "rm -rf build # old"],
				["newline", "rm -rf build\nrm -rf old"],
				["double dash", "rm -rf -- build"],
				["flag after the path", "rm build -rf"],
				["long option", "rm --recursive build"],
				["interactive flag", "rm -rfi build"],
				["sudo", "sudo rm -rf build"],
				["command prefix", "command rm -rf build"],
				["backslash rm", "\\rm -rf build"],
				["env prefix", "X=1 rm -rf build"],
				["not recursive", "rm -f build"],
				["a file, not a directory", "rm -rf build/todos.json"],
				["missing", "rm -rf missing"],
				["rmdir is not this lane", "rmdir build"],
				["find delete", "find build -delete"],
			];
			for (const [why, cmd] of refused)
				test(why, () =>
					expect(ok(cmd.replace("WS", ws).replace("OUTSIDE", outside)), cmd).toBe(false));

			test("a directory made then renamed", () => {
				sh("mkdir made");
				renameSync(join(ws, "made"), join(ws, "renamed"));
				expect(ok("rm -rf renamed")).toBe(false);
			});
			test("a directory made, removed, then made again by something else", () => {
				sh("mkdir swap");
				rmSync(join(ws, "swap"), { recursive: true });
				mkdirSync(join(ws, "swap"));
				expect(ok("rm -rf swap")).toBe(false);
			});
			test("the session's directory replaced by a symlink out", () => {
				rmSync(join(ws, "build"), { recursive: true });
				symlinkSync(outside, join(ws, "build"));
				expect(ok(PILOT_RM)).toBe(false);
			});
			test("an older file moved into the session's directory", () => {
				renameSync(join(ws, "old/note.txt"), join(ws, "build/note.txt"));
				const r = rmOwnDir(PILOT_RM, ws, rec);
				expect(r.ok).toBe(false);
				expect((r as { hint?: string }).hint).toContain("older than the directory");
			});
			test("a file another process dropped into the session's directory (8TO, #4106)", () => {
				put("build/theirs.txt", "not the session's");
				const r = rmOwnDir(PILOT_RM, ws, rec);
				expect(r.ok).toBe(false);
				expect((r as { hint?: string }).hint).toContain(
					"theirs.txt, which is not a file this session wrote",
				);
			});
			test("a directory and file another process made inside it (8TO, #4106)", () => {
				put("build/sub/theirs.txt");
				expect(ok(PILOT_RM)).toBe(false);
				sh("mkdir -p out");
				mkdirSync(join(ws, "out/empty"));
				expect(ok("rm -rf out")).toBe(false);
			});
			test("the session's file replaced by another process (new inode at the same path)", () => {
				rmSync(join(ws, "build/todos.json"));
				put("build/todos.json", "[]");
				expect(ok(PILOT_RM)).toBe(false);
			});
			test("a symlink inside the directory (the record never holds links)", () => {
				symlinkSync(join(ws, "src"), join(ws, "build/src-link"));
				expect(ok(PILOT_RM)).toBe(false);
			});
			test("a nested .git inside the session's directory", () => {
				sh("mkdir -p build/.git");
				expect(ok(PILOT_RM)).toBe(false);
			});
			test("a session directory whose files git now tracks", () => {
				put("build/kept.txt");
				git("add", "build/kept.txt");
				expect(ok(PILOT_RM)).toBe(false);
			});
			test("a dot directory the session made itself", () => {
				sh("mkdir -p .scratch");
				expect(ok("rm -rf .scratch")).toBe(false);
			});
			test("another session's record, or none", () => {
				expect(ok(PILOT_RM, new CreatedFiles())).toBe(false);
				expect(rmOwnDir(PILOT_RM, ws, undefined).ok).toBe(false);
			});
			test("no cwd, or a relative one", () => {
				expect(rmOwnDir(PILOT_RM, undefined, rec).ok).toBe(false);
				expect(rmOwnDir(PILOT_RM, "work", rec).ok).toBe(false);
			});
			test("a refusal says what would pass", () => {
				const r = rmOwnDir("rm -rf old", ws, rec);
				expect((r as { hint?: string }).hint).toContain("not a directory this session made");
				expect((r as { hint?: string }).hint).toContain("rm -f");
			});
		});

		describe("systemOneGate with the lane", () => {
			test("runs the pilot's command without asking the judge", async () => {
				const r = await systemOneGate(PILOT_RM, process.env, ws, rec);
				expect(r.run).toBe(true);
				expect(r.guard?.backend).toBe("allowlist");
				expect(r.guard?.reason).toContain("this session made (build)");
				expect(judge.asks).toBe(0);
			});
			test("a pre-existing directory goes to the judge, and the block says what would pass", async () => {
				const r = await systemOneGate("rm -rf old", process.env, ws, rec);
				expect(r.guard?.backend).not.toBe("allowlist");
				if (!r.run) expect(r.message).toContain("mkdir-only run_command");
			});
			test("strict mode (Guarded) never uses the lane", async () => {
				process.env[SYSTEM_ONE_FLAG] = "1";
				const r = await systemOneGate(PILOT_RM, process.env, ws, rec);
				expect(r.run).toBe(false);
				expect(r.guard?.backend).not.toBe("allowlist");
			});
			test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
				process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
				const r = await systemOneGate(PILOT_RM, process.env, ws, rec);
				expect(r.guard?.backend).not.toBe("allowlist");
			});
			test("without the session's record the lane has no opinion", async () => {
				const r = await systemOneGate(PILOT_RM, process.env, ws);
				expect(r.guard?.backend).not.toBe("allowlist");
			});
		});

		/**
		 * The real tool entry point, as the pilot runs it: the permission layer may
		 * draw its own card for rm -rf and the pilot approves it; System One must
		 * not block.
		 */
		describe("ToolExecutor: mkdir -p build, a file in it, rm -rf build", () => {
			let ttyWas: PropertyDescriptor | undefined;
			beforeEach(() => {
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
			});

			test("the session's own scratch directory goes without the judge", async () => {
				const ex = new ToolExecutor(ws, "owndir");
				await ex.execute("run_command", { command: "mkdir -p scratch" });
				expect(ex.createdFiles.dirCount).toBe(1);
				await ex.execute("run_command", { command: "TODO_FILE=scratch/todos.json sh tools/w.sh" });
				const out = await ex.execute("run_command", { command: "rm -rf scratch" });
				expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(existsSync(join(ws, "scratch"))).toBe(false);
				expect(judge.asks).toBe(0);
			});
			test("the same, with a file another process dropped in: blocked, the file kept", async () => {
				const ex = new ToolExecutor(ws, "owndir3");
				await ex.execute("run_command", { command: "mkdir -p scratch" });
				await ex.execute("run_command", { command: "TODO_FILE=scratch/todos.json sh tools/w.sh" });
				writeFileSync(join(ws, "scratch/theirs.txt"), "x");
				const out = await ex.execute("run_command", { command: "rm -rf scratch" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(existsSync(join(realpathSync(ws), "scratch/theirs.txt"))).toBe(true);
			});
			test("#4516 write_file makes .tmp/a.txt: rmOwnDir passes rm -rf .tmp", async () => {
				const ex = new ToolExecutor(ws, "owndir4516a");
				await ex.execute("write_file", { path: ".tmp/a.txt", content: "hello" });
				expect(ex.createdFiles.dirCount).toBe(1);
				expect(rmOwnDir("rm -rf .tmp", realpathSync(ws), ex.createdFiles).ok).toBe(true);
				const out = await ex.execute("run_command", { command: "rm -rf .tmp" });
				expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(existsSync(join(ws, ".tmp"))).toBe(false);
			});
			test("#4516 a .tmp that was there before the write_file still escalates", async () => {
				mkdirSync(join(ws, ".tmp"));
				const ex = new ToolExecutor(ws, "owndir4516b");
				await ex.execute("write_file", { path: ".tmp/a.txt", content: "hello" });
				expect(ex.createdFiles.dirCount).toBe(0);
				expect(rmOwnDir("rm -rf .tmp", realpathSync(ws), ex.createdFiles).ok).toBe(false);
				const out = await ex.execute("run_command", { command: "rm -rf .tmp" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(existsSync(join(realpathSync(ws), ".tmp/a.txt"))).toBe(true);
			});
			test("#4516 a foreign file dropped into the write_file-made .tmp still escalates", async () => {
				const ex = new ToolExecutor(ws, "owndir4516c");
				await ex.execute("write_file", { path: ".tmp/a.txt", content: "hello" });
				writeFileSync(join(ws, ".tmp/theirs.txt"), "x");
				expect(rmOwnDir("rm -rf .tmp", realpathSync(ws), ex.createdFiles).ok).toBe(false);
				const out = await ex.execute("run_command", { command: "rm -rf .tmp" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(existsSync(join(realpathSync(ws), ".tmp/theirs.txt"))).toBe(true);
			});
			test("#4516 mkdirRecorded for a path outside the cwd records nothing", () => {
				const rec2 = new CreatedFiles();
				mkdirRecorded(join(outside, "x/y"), ws, rec2);
				expect(existsSync(join(outside, "x/y"))).toBe(true);
				expect(rec2.dirCount).toBe(0);
				// A symlink out of the cwd: the new directory resolves outside the realpath of cwd.
				mkdirRecorded(join(ws, "escape/z"), ws, rec2);
				expect(existsSync(join(outside, "z"))).toBe(true);
				expect(rec2.dirCount).toBe(0);
			});
			test("#4516 nested new dirs are all recorded, an existing parent is not", () => {
				const rec2 = new CreatedFiles();
				mkdirRecorded(join(ws, "old/n1/n2"), ws, rec2);
				expect(rec2.dirCount).toBe(2);
				expect(rec2.createdDirBySession(join(ws, "old"))).toBe(false);
				expect(rec2.createdDirBySession(join(ws, "old/n1/n2"))).toBe(true);
			});
			test("a directory that was there before is not the lane's: blocked, with what would pass", async () => {
				const ex = new ToolExecutor(ws, "owndir2");
				const out = await ex.execute("run_command", { command: "rm -rf old" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(out).toContain("mkdir-only run_command");
				expect(existsSync(join(realpathSync(ws), "old/note.txt"))).toBe(true);
			});
		});
	},
);
