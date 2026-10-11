/**
 * #3514: a file a CHILD of the session's own command made (a CLI the model ran
 * with TODO_FILE=.tmp/td.json) counts as the session's, so `rm -f` of exactly
 * that file skips the judge. Pilot l5-feature-e2e, 2026-10-11: `.tmp/td.json`
 * was written by `bun src/cli.ts add`, not by a redirect, so the record was
 * empty and the judge blocked the cleanup.
 *
 * Real git repositories and real shell children throughout. Every case that
 * must stay judged asserts `rmOfNothingOrOwn` is null, the answer that sends
 * the command on to the judge.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { CreatedFiles } from "./s1-created-files";
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

const WIN = process.platform === "win32";
const OLD = new Date("2001-01-01T00:00:00Z");

let ws: string;
let outside: string;
let rec: CreatedFiles;

/** Run `cmd` in `cwd` as a child of a watched command, like run_command does. */
function child(cmd: string, cwd = ws, record = rec): void {
	const done = record.watchCommand(cwd, cmd);
	execSync(cmd, { cwd, stdio: "ignore", shell: "/bin/sh" });
	done();
}
const own = (rel: string) => rec.createdBySession(join(ws, rel));
const rmOwn = (cmd: string) => rmOfNothingOrOwn(cmd, ws, rec);

beforeEach(() => {
	ws = tempDir("s1-child-ws-");
	outside = tempDir("s1-child-out-");
	rec = new CreatedFiles();
	execFileSync("git", ["init", "-q"], { cwd: ws });
	writeFileSync(join(ws, "notes.md"), "tracked");
	execFileSync("git", ["add", "notes.md"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], {
		cwd: ws,
	});
});
afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(WIN)("a file a child of the command made", () => {
	test("is the session's: .tmp/td.json from a CLI, then rm -f of exactly it passes", () => {
		child("mkdir -p .tmp && echo '[]' > .tmp/td.json");
		expect(own(".tmp/td.json")).toBe(true);
		expect(rec.size).toBe(1);
		expect(rmOwn("rm -f .tmp/td.json")).toBe("own-scratch");
		expect(rmOwn("rm .tmp/td.json")).toBe("own-scratch");
	});

	test("stays the session's through its own later in-place and atomic rewrites", () => {
		child("mkdir -p .tmp && echo a > .tmp/td.json");
		child("echo b >> .tmp/td.json");
		expect(own(".tmp/td.json")).toBe(true);
		expect(rmOwn("rm -f .tmp/td.json")).toBe("own-scratch");
		// An atomic rewrite through mv is a rename-class command: not watched, so the entry lapses to the judge.
		child("echo c > .tmp/td.new && mv .tmp/td.new .tmp/td.json");
		expect(own(".tmp/td.json")).toBe(false);
		expect(rmOwn("rm -f .tmp/td.json")).toBeNull();
	});

	test("is not the session's when something else rewrote it between commands", () => {
		child("mkdir -p .tmp && echo a > .tmp/td.json");
		writeFileSync(join(ws, ".tmp/td.json"), "someone else wrote more than before");
		expect(own(".tmp/td.json")).toBe(false);
		expect(rmOwn("rm -f .tmp/td.json")).toBeNull();
	});
});

describe.skipIf(WIN)("everything else stays judged", () => {
	test("an untracked file that existed before is never adopted by a child that edits it", () => {
		writeFileSync(join(ws, "mine.json"), "user data");
		child("echo more >> mine.json");
		child("sed -i.bak s/user/other/ mine.json");
		expect(own("mine.json")).toBe(false);
		expect(rmOwn("rm -f mine.json")).toBeNull();
	});

	test("a tracked file is never the session's", () => {
		child("echo more >> notes.md");
		expect(own("notes.md")).toBe(false);
		expect(rmOwn("rm -f notes.md")).toBeNull();
	});

	test("a file moved in from outside the workspace keeps its old mtime: not recorded", () => {
		const f = join(outside, "precious.txt");
		writeFileSync(f, "x");
		utimesSync(f, OLD, OLD);
		child(`mv ${f} ${join(ws, "moved.txt")}`);
		expect(existsSync(join(ws, "moved.txt"))).toBe(true);
		expect(own("moved.txt")).toBe(false);
		expect(rmOwn("rm -f moved.txt")).toBeNull();
	});

	test("an older untracked file renamed to a new name is not recorded", () => {
		writeFileSync(join(ws, "old.txt"), "x");
		utimesSync(join(ws, "old.txt"), OLD, OLD);
		child("mv old.txt new.txt");
		expect(own("new.txt")).toBe(false);
		expect(rmOwn("rm -f new.txt")).toBeNull();
	});

	test("a hard link to a file outside, or to an older one, is not recorded", () => {
		const f = join(outside, "linked.txt");
		writeFileSync(f, "x");
		linkSync(f, join(outside, "peer.txt"));
		child(`ln ${f} ${join(ws, "hl.txt")}`);
		expect(own("hl.txt")).toBe(false);
		expect(rmOwn("rm -f hl.txt")).toBeNull();
	});

	test("a symlink is never recorded, even to a file inside", () => {
		child("ln -s notes.md sl.txt");
		child(`ln -s ${join(outside, "nowhere")} dangling.txt`);
		expect(own("sl.txt")).toBe(false);
		expect(own("dangling.txt")).toBe(false);
		expect(rmOwn("rm -f sl.txt")).toBeNull();
		expect(rmOwn("rm -f dangling.txt")).toBeNull();
	});

	test("a gitignored name is not recorded (.env, build output)", () => {
		writeFileSync(join(ws, ".gitignore"), ".env\n*.log\n");
		child("echo SECRET=1 > .env && echo x > run.log");
		expect(own(".env")).toBe(false);
		expect(own("run.log")).toBe(false);
		expect(rmOwn("rm -f .env")).toBeNull();
		expect(rmOwn("rm -f run.log")).toBeNull();
	});

	test("a name that was present before any earlier command is not recorded when recreated", () => {
		writeFileSync(join(ws, "keep.txt"), "user data");
		child("rm keep.txt");
		child("echo recreated > keep.txt");
		expect(own("keep.txt")).toBe(false);
		expect(rmOwn("rm -f keep.txt")).toBeNull();
	});

	test("a command during which another untracked file vanished records nothing", () => {
		writeFileSync(join(ws, "victim.txt"), "user data");
		child("rm victim.txt; echo hi > fresh.txt");
		expect(own("fresh.txt")).toBe(false);
		expect(rmOwn("rm -f fresh.txt")).toBeNull();
	});

	test("a tracked file newly missing records nothing, even for a command with no rename word", () => {
		// Same text as an honest build step; only the tracked deletion shows.
		const done = rec.watchCommand(ws);
		execSync("rm notes.md; echo hi > fresh.txt", { cwd: ws });
		done();
		expect(own("fresh.txt")).toBe(false);
	});

	test("a directory is not a file: nothing recorded, rm of it judged", () => {
		child("mkdir adir");
		expect(own("adir")).toBe(false);
		expect(rmOwn("rm -f adir")).toBeNull();
	});

	test("no repository: nothing recorded, and the watch stays off for the session", () => {
		const bare = tempDir("s1-child-bare-");
		child("echo x > f.txt", bare);
		expect(rec.createdBySession(join(bare, "f.txt"))).toBe(false);
		expect(rmOfNothingOrOwn("rm -f f.txt", bare, rec)).toBeNull();
		expect(rec.watchStopped).toBe(true);
		// Circuit breaker: a later command in a real repository records nothing either.
		child("echo y > later.txt");
		expect(own("later.txt")).toBe(false);
		expect(rmOwn("rm -f later.txt")).toBeNull();
		rmSync(bare, { recursive: true, force: true });
	});

	test("a snapshot slower than 500 ms stops the watch for the session", () => {
		const bin = tempDir("s1-child-slowgit-");
		const realGit = execSync("command -v git", { shell: "/bin/sh" }).toString().trim();
		writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 0.7\nexec ${realGit} "$@"\n`, {
			mode: 0o755,
		});
		const pathWas = process.env.PATH;
		process.env.PATH = `${bin}:${pathWas}`;
		try {
			child("echo x > slow.txt");
		} finally {
			process.env.PATH = pathWas;
		}
		expect(rec.watchStopped).toBe(true);
		expect(own("slow.txt")).toBe(false);
		// Real git is back, but the breaker holds.
		child("echo y > after.txt");
		expect(own("after.txt")).toBe(false);
		expect(rmOwn("rm -f after.txt")).toBeNull();
		rmSync(bin, { recursive: true, force: true });
	});

	test("a fast snapshot leaves the watch on", () => {
		child("echo x > fast.txt");
		expect(rec.watchStopped).toBe(false);
		expect(own("fast.txt")).toBe(true);
	});

	test("the closer runs once: a second call after later changes records nothing new", () => {
		const done = rec.watchCommand(ws);
		execSync("echo x > a.txt", { cwd: ws });
		done();
		expect(own("a.txt")).toBe(true);
		execSync("echo y > b.txt", { cwd: ws });
		done();
		expect(own("b.txt")).toBe(false);
	});
});

describe.skipIf(WIN)("what rm may still delete once a child-made file is recorded", () => {
	beforeEach(() => {
		child("mkdir -p .tmp && echo '[]' > .tmp/td.json");
		writeFileSync(join(ws, ".tmp/other.json"), "not made by the session");
		writeFileSync(join(ws, "sibling.txt"), "not made by the session");
		expect(own(".tmp/td.json")).toBe(true);
	});

	test("every blocked shape stays blocked", () => {
		for (const cmd of [
			"rm -rf .tmp/td.json",
			"rm -r .tmp/td.json",
			"rm -rf .tmp",
			"rm -f .tmp",
			"rm -f .tmp/*.json",
			"rm -f .tmp/td.jso?",
			"rm -f .tmp/other.json",
			"rm -f sibling.txt",
			"rm -f .tmp/td.json sibling.txt",
			"rm -f ../td.json",
			"rm -f .tmp/../notes.md",
			"rm -f notes.md",
			"rm -f /etc/hosts",
			`rm -f ${join(ws, ".tmp/td.json")}`,
			"rm -f -- .tmp/td.json",
			"rm -fi .tmp/td.json",
			"rm -f '.tmp/td.json'",
			"rm -f .tmp/td.json; echo x",
			"rm -f .tmp/td.json && ls",
			"cat .tmp/td.json | rm -f .tmp/td.json",
			"git rm -f .tmp/td.json",
			"unlink .tmp/td.json",
		]) {
			expect(rmOwn(cmd)).toBeNull();
		}
	});

	test("the recorded file turned into a symlink, or replaced by a directory, is no longer passed", () => {
		rmSync(join(ws, ".tmp/td.json"));
		symlinkSync(join(outside, "target"), join(ws, ".tmp/td.json"));
		expect(rmOwn("rm -f .tmp/td.json")).toBeNull();
		rmSync(join(ws, ".tmp/td.json"));
		mkdirSync(join(ws, ".tmp/td.json"));
		expect(rmOwn("rm -f .tmp/td.json")).toBeNull();
	});

	test("a tracked file with the recorded name is not passed", () => {
		execFileSync("git", ["add", "-f", ".tmp/td.json"], { cwd: ws });
		expect(rmOwn("rm -f .tmp/td.json")).toBeNull();
	});

	test("another session's record does not know the file", () => {
		expect(rmOfNothingOrOwn("rm -f .tmp/td.json", ws, new CreatedFiles())).toBeNull();
		expect(rmOfNothingOrOwn("rm -f .tmp/td.json", ws, undefined)).toBeNull();
	});
});

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

describe.skipIf(WIN)("the pilot case through the real tool entry point", () => {
	const saved: Record<string, string | undefined> = {};
	const KEYS = [
		SYSTEM_ONE_FLAG,
		SYSTEM_ONE_ALLOWLIST_FLAG,
		"EIGHT_HEADLESS",
		"EIGHT_WORKSPACE_ROOT",
	];
	let judge: RmIsDangerous;
	let ttyWas: PropertyDescriptor | undefined;

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
		// Interactive, as the pilot runs: the permission layer draws its card and the person approves it.
		registerTuiApprovalHandler(async () => "approve");
		Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		judge = new RmIsDangerous();
		_setSystemOneOverridesForTests({
			createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
			askHuman: async () => null,
			calibrationDir: tempDir("s1-child-nocal-"),
		});
		process.env[SYSTEM_ONE_FLAG] = "1";
	});

	afterEach(() => {
		registerTuiApprovalHandler(null);
		if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		process.env.EIGHT_HEADLESS = "1";
	});

	test("a script run by run_command writes .tmp/td.json; rm -f .tmp/td.json skips the judge", async () => {
		const ex = new ToolExecutor(ws, "child-a");
		await ex.execute("write_file", {
			path: "mk.sh",
			content: "mkdir -p .tmp\necho '[]' > .tmp/td.json\n",
		});
		await ex.execute("run_command", { command: "sh mk.sh" });
		expect(existsSync(join(ws, ".tmp/td.json"))).toBe(true);
		const out = await ex.execute("run_command", { command: "rm -f .tmp/td.json" });
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, ".tmp/td.json"))).toBe(false);
		expect(judge.rmAsks).toBe(0);
	});

	test("the same session still cannot delete an untracked file it did not make", async () => {
		const ex = new ToolExecutor(ws, "child-b");
		writeFileSync(join(ws, "theirs.json"), "user data");
		await ex.execute("run_command", { command: "echo hi" });
		const out = await ex.execute("run_command", { command: "rm -f theirs.json" });
		expect(judge.rmAsks).toBeGreaterThan(0);
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(ws, "theirs.json"))).toBe(true);
	});
});

/**
 * 8SO F1 (#3875, head a791b4d8): rename a file the session did not make onto a
 * new name, rewrite it in the same command, then rm it without the judge. Every
 * row below passed the judge on a791b4d8.
 */
describe.skipIf(WIN)("rename then rewrite does not launder a file (8SO F1)", () => {
	beforeEach(() => {
		writeFileSync(join(ws, "t.ts"), "export const a = 1;\n");
		execFileSync("git", ["add", "t.ts"], { cwd: ws });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t"], {
			cwd: ws,
		});
		writeFileSync(join(ws, ".gitignore"), ".env\n");
		writeFileSync(join(ws, ".env"), "SECRET=1\n");
	});

	const rows: Array<[string, string, string]> = [
		["mv + touch", "mv t.ts t2.ts && touch t2.ts", "t2.ts"],
		["mv + sed -i", "mv t.ts t4.ts && sed -i.bak s/a/b/ t4.ts", "t4.ts"],
		["mv + append", "mv t.ts t5.ts && echo x >> t5.ts", "t5.ts"],
		["mv .env + append (secrets)", "mv .env cfg.txt && echo x >> cfg.txt", "cfg.txt"],
		["git rm --cached + touch", "git rm -q --cached t.ts && touch t.ts", "t.ts"],
		["cp -p + touch", "cp -p t.ts t6.ts && touch t6.ts", "t6.ts"],
		["install", "install -m 644 t.ts t7.ts && touch t7.ts", "t7.ts"],
		["ln + touch", "ln t.ts t8.ts && touch t8.ts", "t8.ts"],
	];
	for (const [name, cmd, target] of rows) {
		test(`${name}: the new name stays judged`, () => {
			child(cmd);
			expect(own(target)).toBe(false);
			expect(rmOwn(`rm -f ${target}`)).toBeNull();
		});
	}

	test("rows without the command text: tracked and ignored files are still caught by the snapshots and birth time", () => {
		const rec2 = new CreatedFiles();
		for (const [cmd, target] of [
			["mv t.ts t2.ts && touch t2.ts", "t2.ts"],
			["mv .env cfg.txt && echo x >> cfg.txt", "cfg.txt"],
			["git rm -q --cached t.ts && touch t.ts", "t.ts"],
		] as const) {
			execSync(
				"git reset -q --hard && git clean -fdq && echo .env > .gitignore && echo S=1 > .env",
				{
					cwd: ws,
				},
			);
			const done = rec2.watchCommand(ws);
			execSync(cmd, { cwd: ws, stdio: "ignore" });
			done();
			expect(rec2.createdBySession(join(ws, target))).toBe(false);
		}
	});

	test("mv + sed -i of a tracked file without the command text: the tracked deletion catches it", () => {
		const done = rec.watchCommand(ws);
		execSync("mv t.ts t4.ts && sed -i.bak s/a/b/ t4.ts", { cwd: ws, stdio: "ignore" });
		done();
		expect(own("t4.ts")).toBe(false);
	});

	test("8SO F2: .env laundered by a command the word list cannot see stays judged", () => {
		writeFileSync(join(ws, "sc.sh"), "mv .env cfg.txt\n");
		const rows: Array<[string, string]> = [
			["m''v .env cfg.txt && sed -i.bak s/S/T/ cfg.txt", "cfg.txt"],
			["bash sc.sh && sed -i.bak s/S/T/ cfg.txt", "cfg.txt"],
			["x=$(echo m)v; $x .env cfg.txt && sed -i.bak s/S/T/ cfg.txt", "cfg.txt"],
			[
				`python3 -c "import shutil;shutil.move('.env','cfg.txt')" && sed -i.bak s/S/T/ cfg.txt`,
				"cfg.txt",
			],
		];
		for (const [cmd, target] of rows) {
			rmSync(join(ws, target), { force: true });
			writeFileSync(join(ws, ".env"), "SECRET=1\n");
			const rec2 = new CreatedFiles();
			const done = rec2.watchCommand(ws, cmd);
			execSync(cmd, { cwd: ws, stdio: "ignore", shell: "/bin/sh" });
			done();
			expect(rec2.createdBySession(join(ws, target))).toBe(false);
			expect(rmOfNothingOrOwn(`rm -f ${target}`, ws, rec2)).toBeNull();
			rmSync(join(ws, ".env.bak"), { force: true });
		}
	});

	test("8SO F3: a file moved out of a gitignored directory stays judged", () => {
		writeFileSync(join(ws, ".gitignore"), ".env\nsecrets/\n");
		mkdirSync(join(ws, "secrets"));
		writeFileSync(join(ws, "secrets/key"), "K=1\n");
		const cmd = "m''v secrets/key cfg.txt && sed -i.b s/K/Z/ cfg.txt";
		const done = rec.watchCommand(ws, cmd);
		execSync(cmd, { cwd: ws, stdio: "ignore", shell: "/bin/sh" });
		done();
		expect(existsSync(join(ws, "secrets/key"))).toBe(false);
		expect(own("cfg.txt")).toBe(false);
		expect(rmOwn("rm -f cfg.txt")).toBeNull();
	});

	test("8SO F3: a command that adds a file to an ignored directory records nothing; a quiet one does", () => {
		writeFileSync(join(ws, ".gitignore"), "out/\n");
		mkdirSync(join(ws, "out"));
		child("echo b > out/build.txt && echo x > made.txt");
		expect(own("made.txt")).toBe(false);
		child("echo y > quiet.txt");
		expect(own("quiet.txt")).toBe(true);
	});

	test("8SO F2: os.rename, renameSync, shutil.move, rename( are rename-class words", () => {
		for (const cmd of [
			`python3 -c "import os;os.rename('.env','c.txt')"`,
			`node -e "require('fs').renameSync('.env','c.txt')"`,
			`python3 -c "import shutil;shutil.move('.env','c.txt')"`,
			`node -e "rename('.env','c.txt')"`,
		]) {
			const rec2 = new CreatedFiles();
			const done = rec2.watchCommand(ws, cmd);
			writeFileSync(join(ws, "c.txt"), "new");
			done();
			expect(rec2.createdBySession(join(ws, "c.txt"))).toBe(false);
			rmSync(join(ws, "c.txt"), { force: true });
		}
	});

	test("controls: an honest new file and a pre-existing user file", () => {
		writeFileSync(join(ws, "user.txt"), "theirs");
		child("echo ok > honest.txt");
		expect(own("honest.txt")).toBe(true);
		expect(rmOwn("rm -f honest.txt")).toBe("own-scratch");
		expect(own("user.txt")).toBe(false);
		expect(rmOwn("rm -f user.txt")).toBeNull();
	});
});

describe.skipIf(WIN)("long and backgrounded commands record nothing (8SO hardening)", () => {
	test("a backgrounded command, nohup, setsid", () => {
		child("echo a > bg1.txt &");
		child("nohup sh -c 'echo b > bg2.txt' ");
		// setsid is not on macOS: only its word is under test.
		const done = rec.watchCommand(ws, "setsid sh -c 'echo c > bg3.txt'");
		execSync("echo c > bg3.txt", { cwd: ws });
		done();
		for (const f of ["bg1.txt", "bg2.txt", "bg3.txt"]) expect(own(f)).toBe(false);
	});

	test("&& and 2>&1 are not backgrounding", () => {
		child("echo a > fg1.txt && echo b > fg2.txt 2>&1");
		expect(own("fg1.txt")).toBe(true);
		expect(own("fg2.txt")).toBe(true);
	});

	test("a command that runs over 30 s records nothing", () => {
		const realNow = Date.now;
		let skew = 0;
		Date.now = () => realNow() + skew;
		try {
			const done = rec.watchCommand(ws, "slow build");
			execSync("echo x > long.txt", { cwd: ws });
			skew = 31_000;
			done();
		} finally {
			Date.now = realNow;
		}
		expect(own("long.txt")).toBe(false);
	});
});
