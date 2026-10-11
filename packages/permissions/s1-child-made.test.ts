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
	const done = record.watchCommand(cwd);
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
		child("echo c > .tmp/td.new && mv .tmp/td.new .tmp/td.json");
		expect(own(".tmp/td.json")).toBe(true);
		expect(rmOwn("rm -f .tmp/td.json")).toBe("own-scratch");
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

	test("a command during which a tracked file went missing records nothing", () => {
		child("rm notes.md; echo hi > fresh.txt");
		expect(own("fresh.txt")).toBe(false);
	});

	test("a directory is not a file: nothing recorded, rm of it judged", () => {
		child("mkdir adir");
		expect(own("adir")).toBe(false);
		expect(rmOwn("rm -f adir")).toBeNull();
	});

	test("no repository: nothing recorded", () => {
		const bare = tempDir("s1-child-bare-");
		child("echo x > f.txt", bare);
		expect(rec.createdBySession(join(bare, "f.txt"))).toBe(false);
		expect(rmOfNothingOrOwn("rm -f f.txt", bare, rec)).toBeNull();
		rmSync(bare, { recursive: true, force: true });
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
