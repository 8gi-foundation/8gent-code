/**
 * #3669: System One must not block removing one stale scratch file.
 *
 * The exact pilot case (troubleshoot-practice, main a5f476d8, run
 * 2026-10-08_185418): worker.sh waits while run/worker.lock exists; the lock
 * names a pid that has exited. The agent ran `rm -f run/worker.lock`, then
 * `unlink run/worker.lock`; rules rm_non_temp and unlink escalated and the
 * judge blocked both.
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
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { SINGLE_FILE_DELETE_HINT, singleFileDelete } from "./s1-rm-single";
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

// Windows refuses a filename that starts with a colon; those cases run on POSIX only.
const HAS_COLON_NAMES = process.platform !== "win32";

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

const PILOT = "rm -f run/worker.lock";
const PILOT_UNLINK = "unlink run/worker.lock";

let ws: string;
let outside: string;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });

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
	ws = tempDir("s1-single-ws-");
	outside = tempDir("s1-single-out-");
	git(ws, "init", "-q");
	// The fixture as the scenario builds it: a tracked worker and config, and
	// a tracked lock under run/ to prove "under run/" alone is not enough.
	mkdirSync(join(ws, "run"));
	mkdirSync(join(ws, "config"));
	writeFileSync(join(ws, "worker.sh"), "while [ -e run/worker.lock ]; do sleep 1; done\n");
	writeFileSync(join(ws, "config", "rates.json"), "{}");
	writeFileSync(join(ws, "run", "tracked.lock"), "pid=1");
	git(ws, "add", "worker.sh", "config/rates.json", "run/tracked.lock");
	git(ws, "commit", "-qm", "init");
	// The stale lock: untracked, there before the session, owner long gone.
	writeFileSync(join(ws, "run", "worker.lock"), "pid=99999\n");
	writeFileSync(join(ws, "run", "other.lock"), "pid=99998\n");
	// Staged but not committed: tracked as far as the index goes.
	writeFileSync(join(ws, "run", "staged.lock"), "pid=5");
	git(ws, "add", "run/staged.lock");
	// Other untracked scratch-style files, and a plain untracked file at the root.
	mkdirSync(join(ws, "tmp"));
	writeFileSync(join(ws, "tmp", "scratch.txt"), "x");
	mkdirSync(join(ws, ".cache"));
	writeFileSync(join(ws, ".cache", "index.json"), "{}");
	writeFileSync(join(ws, "server.pid"), "4242");
	writeFileSync(join(ws, "old.log"), "pre-existing");
	writeFileSync(join(ws, ".env"), "SECRET=1");
	// A directory under run/.
	mkdirSync(join(ws, "run", "sub"));
	writeFileSync(join(ws, "run", "sub", "a.lock"), "pid=1");
	// Symlinks: a file link out of the workspace, a directory link out of it,
	// a file link inside it, and a directory link into .git/.
	writeFileSync(join(outside, "victim.lock"), "pid=1");
	mkdirSync(join(outside, "locks"));
	writeFileSync(join(outside, "locks", "a.lock"), "pid=1");
	symlinkSync(join(outside, "victim.lock"), join(ws, "run", "escape.lock"));
	symlinkSync(join(outside, "locks"), join(ws, "escape"));
	symlinkSync(join(ws, "run", "worker.lock"), join(ws, "run", "alias.lock"));
	symlinkSync(join(ws, ".git"), join(ws, "run", "g"));
	// Tracked files whose names need the literal, case-insensitive check:
	// a capitalised twin and a name that starts with a colon.
	writeFileSync(join(ws, "run", "Case.lock"), "pid=1");
	// A colon cannot start a filename on Windows (it is the drive/stream separator), so the
	// colon-named fixtures exist on POSIX only. The command grammar admits no other character
	// that git treats as pathspec magic and Windows allows, so there is no twin to add.
	const literalNames = ["run/Case.lock"];
	if (HAS_COLON_NAMES) {
		writeFileSync(join(ws, "run", ":colon.lock"), "pid=1");
		literalNames.push(":(literal)run/:colon.lock");
	}
	git(ws, "add", "--", ...literalNames);
	git(ws, "commit", "-qm", "names");
	if (HAS_COLON_NAMES) writeFileSync(join(ws, "run", ":free.lock"), "pid=1");
	// An independent repository nested under run/, with a tracked lock.
	mkdirSync(join(ws, "run", "nested"));
	git(join(ws, "run", "nested"), "init", "-q");
	writeFileSync(join(ws, "run", "nested", "a.lock"), "pid=1");
	writeFileSync(join(ws, "run", "nested", "free.lock"), "pid=1");
	git(join(ws, "run", "nested"), "add", "a.lock");
	git(join(ws, "run", "nested"), "commit", "-qm", "nested");
	// A submodule under run/, with a tracked lock of its own.
	const modSrc = join(outside, "modsrc");
	mkdirSync(modSrc);
	git(modSrc, "init", "-q");
	writeFileSync(join(modSrc, "m.lock"), "pid=1");
	git(modSrc, "add", "m.lock");
	git(modSrc, "commit", "-qm", "mod");
	git(ws, "-c", "protocol.file.allow=always", "submodule", "add", "-q", modSrc, "run/mod");
	git(ws, "commit", "-qm", "submodule");
	// A .git internal that looks exactly like a stale lock. Written after the
	// last git command above, since git refuses to work while it exists.
	writeFileSync(join(ws, ".git", "index.lock"), "");
	// Dependency lockfiles and sensitive names in scratch places, all untracked.
	writeFileSync(join(ws, "run", "bun.lock"), "{}");
	writeFileSync(join(ws, "tmp", "yarn.lock"), "");
	writeFileSync(join(ws, "Cargo.lock"), "");
	writeFileSync(join(ws, "run", ".env"), "SECRET=1");
	writeFileSync(join(ws, "run", ".env.local"), "SECRET=1");
	writeFileSync(join(ws, ".cache", "credentials.pem"), "");
	writeFileSync(join(ws, ".cache", "id.key"), "");
	writeFileSync(join(ws, "run", "cert.p12"), "");
	writeFileSync(join(ws, "tmp", "data.sqlite"), "");
	writeFileSync(join(ws, "tmp", "data.sqlite3"), "");
	writeFileSync(join(ws, "tmp", "app.db"), "");
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-single-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
});

describe("singleFileDelete", () => {
	test("the pilot case: rm -f of the stale lock", () => {
		expect(singleFileDelete(PILOT, ws)).toEqual({ ok: true, rel: "run/worker.lock" });
	});

	test("the pilot's second try: unlink of the stale lock", () => {
		expect(singleFileDelete(PILOT_UNLINK, ws)).toEqual({ ok: true, rel: "run/worker.lock" });
	});

	for (const cmd of [
		"rm run/worker.lock",
		"rm -fv run/worker.lock",
		"rm -f ./run/worker.lock",
		"rm -f tmp/scratch.txt",
		"rm -f .cache/index.json",
		"rm -f server.pid",
	]) {
		test(`passes: ${cmd}`, () => {
			expect(singleFileDelete(cmd, ws).ok).toBe(true);
		});
	}

	const refused: Array<[string, string]> = [
		["a tracked file under run/", "rm -f run/tracked.lock"],
		["a staged file under run/", "rm -f run/staged.lock"],
		["a tracked file at the root", "rm -f worker.sh"],
		["an untracked file that is not scratch-style", "rm -f old.log"],
		["an untracked .env", "rm -f .env"],
		["a directory", "rm -f run/sub"],
		["a recursive delete", "rm -rf run"],
		["a recursive delete of one file", "rm -r run/worker.lock"],
		["two operands", "rm -f run/worker.lock run/other.lock"],
		["a glob", "rm -f run/*.lock"],
		["a brace expansion", "rm -f run/{worker,other}.lock"],
		["a variable", "rm -f $LOCK"],
		["a quoted path", "rm -f 'run/worker.lock'"],
		["a .. path", "rm -f ../victim.lock"],
		["a symlink pointing outside", "rm -f run/escape.lock"],
		["a file under a symlinked directory pointing outside", "rm -f escape/a.lock"],
		["a symlink pointing inside", "rm -f run/alias.lock"],
		["a .git internal", "rm -f .git/index.lock"],
		["a .git internal through a symlinked directory", "rm -f run/g/index.lock"],
		["a .git internal in another case", "rm -f .GIT/index.lock"],
		["an absent path (left to the rm-of-nothing rule)", "rm -f run/nope.lock"],
		["rm with --", "rm -f -- run/worker.lock"],
		["rm -d", "rm -d run/worker.lock"],
		["unlink with a flag", "unlink -f run/worker.lock"],
		["unlink of two operands", "unlink run/worker.lock run/other.lock"],
		["a pipe", "rm -f run/worker.lock | cat"],
		["a chain", "rm -f run/worker.lock; echo done"],
		["mv of the lock", "mv run/worker.lock run/worker.lock.stale"],
		["a different binary", "shred run/worker.lock"],
		// Tracked status is read from the file's own directory, by literal name.
		["a tracked file spelt in another case", "rm -f run/case.lock"],
		["a tracked file spelt in its own case", "rm -f run/Case.lock"],
		...(HAS_COLON_NAMES
			? [["a tracked file whose name starts with a colon", "rm -f run/:colon.lock"]]
			: []),
		["a file tracked by a nested repository", "rm -f run/nested/a.lock"],
		["a file tracked by a submodule", "rm -f run/mod/m.lock"],
		// Dependency lockfiles are project state, not scratch.
		["bun.lock under run/", "rm -f run/bun.lock"],
		["yarn.lock under tmp/", "rm -f tmp/yarn.lock"],
		["Cargo.lock at the root", "rm -f Cargo.lock"],
		// Sensitive names, even inside scratch directories.
		[".env under run/", "rm -f run/.env"],
		[".env.local under run/", "rm -f run/.env.local"],
		["a .pem under .cache/", "rm -f .cache/credentials.pem"],
		["a .key under .cache/", "rm -f .cache/id.key"],
		["a .p12 under run/", "rm -f run/cert.p12"],
		["a .sqlite under tmp/", "rm -f tmp/data.sqlite"],
		["a .sqlite3 under tmp/", "rm -f tmp/data.sqlite3"],
		["a .db under tmp/", "rm -f tmp/app.db"],
	];
	for (const [why, cmd] of refused) {
		test(`refuses ${why}: ${cmd}`, () => {
			expect(singleFileDelete(cmd, ws).ok).toBe(false);
		});
	}

	test("refuses an absolute path outside the workspace, existing or not", () => {
		const victim = join(outside, "victim.lock");
		expect(existsSync(victim)).toBe(true);
		expect(singleFileDelete(`rm -f ${victim}`, ws).ok).toBe(false);
		expect(singleFileDelete(`unlink ${victim}`, ws).ok).toBe(false);
		// An absolute path to the lock itself, inside the workspace, is still refused:
		// the rule takes relative paths only.
		expect(singleFileDelete(`rm -f ${join(ws, "run", "worker.lock")}`, ws).ok).toBe(false);
	});

	test.skipIf(!HAS_COLON_NAMES)("literal names: an untracked colon-named lock still passes (POSIX only: Windows forbids a leading colon)", () => {
		expect(singleFileDelete("rm -f run/:free.lock", ws)).toEqual({
			ok: true,
			rel: "run/:free.lock",
		});
	});

	test("literal names: an untracked lock in a nested repository still passes", () => {
		expect(singleFileDelete("rm -f run/nested/free.lock", ws)).toEqual({
			ok: true,
			rel: "run/nested/free.lock",
		});
	});

	test("a root that is not a repository, holding a nested repository with a tracked lock", () => {
		const plain = tempDir("s1-single-plainnest-");
		mkdirSync(join(plain, "run", "inner"), { recursive: true });
		git(join(plain, "run", "inner"), "init", "-q");
		writeFileSync(join(plain, "run", "inner", "t.lock"), "pid=1");
		writeFileSync(join(plain, "run", "inner", "u.lock"), "pid=1");
		git(join(plain, "run", "inner"), "add", "t.lock");
		git(join(plain, "run", "inner"), "commit", "-qm", "inner");
		expect(singleFileDelete("rm -f run/inner/t.lock", plain).ok).toBe(false);
		expect(singleFileDelete("rm -f run/inner/u.lock", plain).ok).toBe(true);
		rmSync(plain, { recursive: true, force: true });
	});

	describe("inherited git env does not change which repository is asked", () => {
		const GIT_KEYS = [
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_COMMON_DIR",
			"GIT_CEILING_DIRECTORIES",
		];
		const was: Record<string, string | undefined> = {};
		beforeEach(() => {
			for (const k of GIT_KEYS) was[k] = process.env[k];
		});
		afterEach(() => {
			for (const k of GIT_KEYS) {
				if (was[k] === undefined) Reflect.deleteProperty(process.env, k);
				else process.env[k] = was[k];
			}
		});

		const cases: Array<[string, () => void]> = [
			["GIT_DIR to a missing path", () => (process.env.GIT_DIR = "/nonexistent/.git")],
			[
				"GIT_DIR to the outside repository",
				() => (process.env.GIT_DIR = join(outside, "modsrc", ".git")),
			],
			["GIT_WORK_TREE to the outside directory", () => (process.env.GIT_WORK_TREE = outside)],
			[
				"GIT_INDEX_FILE to a missing path",
				() => (process.env.GIT_INDEX_FILE = "/nonexistent/index"),
			],
			["GIT_COMMON_DIR to a missing path", () => (process.env.GIT_COMMON_DIR = "/nonexistent")],
			[
				"GIT_CEILING_DIRECTORIES at the workspace",
				() => (process.env.GIT_CEILING_DIRECTORIES = ws),
			],
		];
		for (const [why, set] of cases) {
			test(`${why}: the tracked lock is still refused and the stale one still passes`, () => {
				set();
				expect(singleFileDelete("rm -f run/tracked.lock", ws).ok).toBe(false);
				expect(singleFileDelete(PILOT, ws)).toEqual({ ok: true, rel: "run/worker.lock" });
			});
		}
	});

	test("no working directory, or a relative one", () => {
		expect(singleFileDelete(PILOT, undefined).ok).toBe(false);
		expect(singleFileDelete(PILOT, "run").ok).toBe(false);
	});

	test("outside any git repository an untracked scratch file still passes", () => {
		const plain = tempDir("s1-single-plain-");
		mkdirSync(join(plain, "run"));
		writeFileSync(join(plain, "run", "worker.lock"), "pid=1");
		expect(singleFileDelete(PILOT, plain).ok).toBe(true);
		rmSync(plain, { recursive: true, force: true });
	});

	test("hints say why in plain words and what is allowed", () => {
		const hint = (cmd: string) => {
			const r = singleFileDelete(cmd, ws);
			return r.ok ? "" : (r.hint ?? "");
		};
		expect(hint("rm -f old.log")).toStartWith("That file is not a scratch file.");
		expect(hint("rm -f run/tracked.lock")).toStartWith("That file is tracked by git.");
		expect(hint("rm -f run/mod/m.lock")).toStartWith("That file is tracked by git.");
		expect(hint("rm -f run/nested/a.lock")).toStartWith("That file is tracked by git.");
		if (HAS_COLON_NAMES) {
			expect(hint("rm -f run/:colon.lock")).toStartWith("That file is tracked by git.");
		}
		// On a case-insensitive file system the other spelling names the same
		// file, and it is the tracked check that refuses it, not the lstat.
		if (process.platform === "darwin")
			expect(hint("rm -f run/case.lock")).toStartWith("That file is tracked by git.");
		expect(hint("rm -f run/bun.lock")).toStartWith("That is a dependency lockfile");
		expect(hint("rm -f run/.env")).toStartWith("That file name needs review.");
		expect(hint("rm -f run/worker.lock run/other.lock")).toStartWith(
			"Remove one file per command.",
		);
		expect(hint("rm -f run/sub")).toStartWith("That is a directory");
		expect(hint("rm -f run/*.lock")).toStartWith("Name one file explicitly");
		expect(hint("rm -rf run")).toStartWith("A recursive delete always needs review.");
		expect(hint("rm -f run/escape.lock")).toStartWith("Only a regular file");
		expect(hint("rm -f escape/a.lock")).toStartWith("That path resolves outside");
		for (const cmd of ["rm -f old.log", "rm -f run/sub", "rm -f run/*.lock"])
			expect(hint(cmd)).toEndWith(SINGLE_FILE_DELETE_HINT);
		// Not even close: no hint.
		expect(hint("shred run/worker.lock")).toBe("");
		expect(hint("rm -f .git/index.lock")).toBe("");
	});
});

describe("systemOneGate", () => {
	test("the pilot case runs without asking the judge", async () => {
		const g = await systemOneGate(PILOT, process.env, ws);
		expect(g.run).toBe(true);
		expect(g.guard?.backend).toBe("allowlist");
		expect(g.guard?.reason).toContain("run/worker.lock");
		expect(judge.asks).toBe(0);
	});

	test("unlink of the stale lock runs without asking the judge", async () => {
		const g = await systemOneGate(PILOT_UNLINK, process.env, ws);
		expect(g.run).toBe(true);
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
		"rm -f run/tracked.lock",
		"rm -f run/staged.lock",
		"rm -f old.log",
		"rm -f .env",
		"rm -f run/sub",
		"rm -rf run",
		"rm -f run/worker.lock run/other.lock",
		"rm -f run/*.lock",
		"rm -f ../victim.lock",
		"rm -f run/escape.lock",
		"rm -f escape/a.lock",
		"rm -f .git/index.lock",
		"rm -f run/g/index.lock",
		"unlink run/worker.lock run/other.lock",
		"mv run/worker.lock run/worker.lock.stale",
		// a case twin only exists on a case-insensitive filesystem; on Linux run/case.lock is absent,
		// and removing an absent file is already allowed by the rm-of-nothing rule
		...(process.platform === "darwin" ? ["rm -f run/case.lock"] : []),
		...(HAS_COLON_NAMES ? ["rm -f run/:colon.lock"] : []),
		"rm -f run/nested/a.lock",
		"rm -f run/mod/m.lock",
		"rm -f run/bun.lock",
		"rm -f run/.env",
		"rm -f tmp/data.sqlite",
	]) {
		test(`still judged and blocked: ${cmd}`, async () => {
			const g = await systemOneGate(cmd, process.env, ws);
			expect(g.run).toBe(false);
			expect(g.guard?.backend).not.toBe("allowlist");
			expect(judge.asks).toBe(1);
		});
	}

	test("a block carries the reason and the allowed alternative", async () => {
		const g = await systemOneGate("rm -f run/worker.lock run/other.lock", process.env, ws);
		expect(g.run).toBe(false);
		expect(g.message).toContain("Remove one file per command.");
		expect(g.message).toContain(SINGLE_FILE_DELETE_HINT);
		// The hint sits before the no-retry line and the command echo.
		const m = g.message ?? "";
		expect(m.indexOf(SINGLE_FILE_DELETE_HINT)).toBeLessThan(
			m.indexOf("Do not run this command again"),
		);
	});

	test("a block with no near-miss carries no hint", async () => {
		const g = await systemOneGate("rm -f .git/index.lock", process.env, ws);
		expect(g.run).toBe(false);
		expect(g.message).not.toContain(SINGLE_FILE_DELETE_HINT);
	});
});

/**
 * As in the TUI: the permission layer still draws its own card for a
 * dangerous rm (approved here), System One is not asked, and the lock is gone.
 */
describe("integration: the real run_command path", () => {
	let cards: string[] = [];
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

	test("ToolExecutor run_command: the stale lock is removed, no System One block", async () => {
		const out = await new ToolExecutor(ws, "s1-single-test").execute("run_command", {
			command: PILOT,
		});
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.asks).toBe(0);
		expect(existsSync(join(ws, "run", "worker.lock"))).toBe(false);
		// At most the permission layer's own card for the rm; never a System One card.
		for (const c of cards) expect(c).toBe(PILOT);
	});

	test("ToolExecutor run_command: a tracked lock under run/ is still judged and blocked", async () => {
		const out = await new ToolExecutor(ws, "s1-single-test").execute("run_command", {
			command: "rm -f run/tracked.lock",
		});
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(out).toContain("That file is tracked by git.");
		expect(existsSync(join(ws, "run", "tracked.lock"))).toBe(true);
	});

	test("ToolExecutor run_command: a .git internal is never auto-allowed", async () => {
		const out = await new ToolExecutor(ws, "s1-single-test").execute("run_command", {
			command: "rm -f .git/index.lock",
		});
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, ".git", "index.lock"))).toBe(true);
	});
});
