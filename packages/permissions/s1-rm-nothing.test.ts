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
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import type { CreatedFiles } from "./s1-created-files";
import { rmOfNothing, rmOfNothingOrOwn } from "./s1-rm-nothing";
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

/**
 * #3381, narrow option (8SO review, 2026-10-03): `rm -f` of an ABSENT absolute
 * path whose nearest existing ancestor's realpath is inside a real temp root
 * deletes nothing, so the judge is not asked. Pilot run 2026-10-03_081746 ran
 * `rm -f /tmp/todos.json`; no rule fired and the judge blocked it.
 * Not covered on purpose: an existing file in a temp root (recording named temp
 * files is deferred), globs, and files a child process wrote (run 003738).
 */
describe("#3381: absent absolute paths under a temp root", () => {
	const uniq = () => `s1-3381-${process.pid}-${Math.random().toString(36).slice(2)}`;
	const ownOnly = (abs: string) =>
		({ createdBySession: (p: string) => p === abs }) as unknown as CreatedFiles;
	let tmp: string;
	beforeEach(() => {
		tmp = tempDir("s1-3381-tmp-");
	});

	test("the pilot shape: rm -f /tmp/<absent>.json", () => {
		const p = `/tmp/${uniq()}.json`;
		expect(existsSync(p)).toBe(false);
		expect(rmOfNothingOrOwn(`rm -f ${p}`, ws)).toBe("nothing-temp");
	});

	test("the exact pilot command passes when /tmp/todos.json is absent, and not when it exists", () => {
		const kind = rmOfNothingOrOwn("rm -f /tmp/todos.json", ws);
		expect(kind).toBe(existsSync("/tmp/todos.json") ? null : "nothing-temp");
	});

	test("absent paths in os.tmpdir(), a uid-owned real directory chain", () => {
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/todos.json`, ws)).toBe("nothing-temp");
		expect(rmOfNothingOrOwn(`rm ${tmp}/a.json ${tmp}/b.json`, ws)).toBe("nothing-temp");
	});

	test("an absent file in an existing uid-owned real subdirectory passes", () => {
		mkdirSync(join(tmp, "sub", "deeper"), { recursive: true });
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/sub/todos.json`, ws)).toBe("nothing-temp");
		expect(rmOfNothingOrOwn(`rm -fv ${tmp}/sub/deeper/todos.json`, ws)).toBe("nothing-temp");
	});

	// B1 (8SO, 2026-10-03): an absent intermediate directory could be planted as
	// a symlink out of temp between the check and the rm.
	test("refuses an absent intermediate directory", () => {
		expect(rmOfNothingOrOwn(`rm -fv ${tmp}/gone/also/todos.json`, ws)).toBeNull();
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/gone/todos.json`, ws)).toBeNull();
		expect(rmOfNothingOrOwn(`rm -f /tmp/${uniq()}/todos.json`, ws)).toBeNull();
	});

	test("refuses a symlinked intermediate directory, even one pointing inside temp", () => {
		mkdirSync(join(tmp, "real"));
		symlinkSync(join(tmp, "real"), join(tmp, "inlink"));
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/real/todos.json`, ws)).toBe("nothing-temp");
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/inlink/todos.json`, ws)).toBeNull();
		mkdirSync(join(tmp, "real", "x"));
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/inlink/x/todos.json`, ws)).toBeNull();
	});

	test("refuses a parent that is a file, not a directory", () => {
		writeFileSync(join(tmp, "afile"), "x");
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/afile/todos.json`, ws)).toBeNull();
	});

	// B2 (8SO, 2026-10-03): a uid-owned directory that group or others can write
	// lets another user rename a child and plant a symlink out of temp between
	// the check and the rm. Every directory below the temp root must have
	// (mode & 0o022) === 0.
	describe("B2: directories below the temp root writable by group or others", () => {
		const made: string[] = [];
		// A 0555 directory would make the recursive cleanup fail; restore first.
		afterEach(() => {
			for (const d of made.splice(0)) chmodSync(d, 0o700);
		});
		const dirWithMode = (name: string, mode: number) => {
			const d = join(tmp, name);
			made.push(d);
			mkdirSync(join(d, "inner"), { recursive: true });
			chmodSync(join(d, "inner"), 0o700);
			chmodSync(d, mode);
			return d;
		};

		test.each([
			["0777", 0o777],
			["0775", 0o775],
			["0757", 0o757],
			["1777 (sticky is not enough)", 0o1777],
		])("refuses a %s intermediate", (_label, mode) => {
			const d = dirWithMode("ww", mode);
			expect(rmOfNothingOrOwn(`rm -f ${d}/inner/todos.json`, ws)).toBeNull();
		});

		test.each([
			["0777", 0o777],
			["0775", 0o775],
		])("refuses a %s parent", (_label, mode) => {
			const d = dirWithMode("wp", mode);
			expect(rmOfNothingOrOwn(`rm -f ${d}/todos.json`, ws)).toBeNull();
		});

		test.each([
			["0755", 0o755],
			["0700", 0o700],
			["0555", 0o555],
		])("allows a %s intermediate and parent", (_label, mode) => {
			const d = dirWithMode("ok", mode);
			expect(rmOfNothingOrOwn(`rm -f ${d}/inner/todos.json`, ws)).toBe("nothing-temp");
			expect(rmOfNothingOrOwn(`rm -f ${d}/todos.json`, ws)).toBe("nothing-temp");
		});

		test("the temp root itself (/tmp, mode 1777 and root-owned) is unaffected", () => {
			expect(lstatSync(realpathSync("/tmp")).mode & 0o022).not.toBe(0);
			expect(rmOfNothingOrOwn(`rm -f /tmp/${uniq()}.json`, ws)).toBe("nothing-temp");
		});
	});

	describe("a parent owned by another uid (process.getuid stubbed)", () => {
		const realGetuid = process.getuid;
		beforeEach(() => {
			const other = (realGetuid?.call(process) ?? 0) + 1;
			process.getuid = () => other;
		});
		afterEach(() => {
			process.getuid = realGetuid;
		});

		test("refuses an absent file under a directory this uid does not own", () => {
			mkdirSync(join(tmp, "sub"));
			expect(rmOfNothingOrOwn(`rm -f ${tmp}/todos.json`, ws)).toBeNull();
			expect(rmOfNothingOrOwn(`rm -f ${tmp}/sub/todos.json`, ws)).toBeNull();
		});

		test("an absent file directly in /tmp still passes: the parent is the temp root", () => {
			expect(rmOfNothingOrOwn(`rm -f /tmp/${uniq()}.json`, ws)).toBe("nothing-temp");
		});
	});

	test("mixed with an absent workspace path (rm_non_temp fired)", () => {
		expect(rmOfNothingOrOwn(`rm -f .bunout.txt ${tmp}/todos.json`, ws)).toBe("nothing-temp");
	});

	test("an own scratch file plus an absent temp path is own-scratch", () => {
		const created = ownOnly(join(realpathSync(ws), "bunout.txt"));
		expect(rmOfNothingOrOwn(`rm -f bunout.txt ${tmp}/todos.json`, ws, created)).toBe("own-scratch");
	});

	test("refuses a file that exists in the temp root (named temp files are deferred)", () => {
		writeFileSync(join(tmp, "todos.json"), "[]");
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/todos.json`, ws)).toBeNull();
	});

	test("refuses an existing temp file even when the session record claims it", () => {
		writeFileSync(join(tmp, "todos.json"), "[]");
		const created = { createdBySession: () => true } as unknown as CreatedFiles;
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/todos.json`, ws, created)).toBeNull();
	});

	test("refuses a hard link in the temp root (it exists)", () => {
		writeFileSync(join(outside, "real.txt"), "x");
		linkSync(join(outside, "real.txt"), join(tmp, "hard.txt"));
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/hard.txt`, ws)).toBeNull();
	});

	test("refuses an absent path under a temp symlink that points out of every temp root", () => {
		symlinkSync(realpathSync(import.meta.dir), join(tmp, "ln"));
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/ln/nope-3381.txt`, ws)).toBeNull();
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/ln/gone/nope-3381.txt`, ws)).toBeNull();
	});

	test("refuses the temp symlink itself, and a dangling one", () => {
		symlinkSync(realpathSync(import.meta.dir), join(tmp, "ln"));
		symlinkSync(join(tmp, "gone"), join(tmp, "dangling"));
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/ln`, ws)).toBeNull();
		expect(rmOfNothingOrOwn(`rm -f ${tmp}/dangling`, ws)).toBeNull();
	});

	const refused: Array<[string, () => string]> = [
		["a text match on /tmp that is not /tmp", () => `rm -f /tmp-x-3381/${uniq()}`],
		["a /tmpfoo sibling", () => `rm -f /tmpfoo-3381/${uniq()}`],
		["a .. segment escaping /tmp", () => "rm -f /tmp/../etc/nope-3381"],
		["a .. segment that stays in /tmp", () => `rm -f /tmp/a/../${uniq()}`],
		["a . segment", () => `rm -f /tmp/./${uniq()}`],
		["a double slash", () => `rm -f /tmp//${uniq()}`],
		["a trailing slash", () => `rm -f /tmp/${uniq()}/`],
		["a /scratchpad text match at the root", () => `rm -f /scratchpad/${uniq()}`],
		[
			"a /scratchpad text match outside temp",
			() => `rm -f ${realpathSync(homedir())}/scratchpad/${uniq()}`,
		],
		["a relative path containing /scratchpad (zero rules)", () => `rm -f foo/scratchpad/${uniq()}`],
		["a relative path containing /claude-501/ (zero rules)", () => `rm -f a/claude-501/${uniq()}`],
		["an absent /etc path", () => "rm -f /etc/nope-3381"],
		[
			"an absent path in the repo checkout",
			() => `rm -f ${realpathSync(import.meta.dir)}/nope-3381`,
		],
		[
			"an absent temp path mixed with an absent non-temp one",
			() => `rm -f /tmp/${uniq()} /etc/nope-3381`,
		],
		["the temp root itself", () => "rm -f /tmp"],
		["recursive force on an absent temp path", () => `rm -${"r"}f /tmp/${uniq()}`],
		["recursive on an absent temp path", () => `rm -${"r"} /tmp/${uniq()}`],
		["rm -d", () => `rm -d /tmp/${uniq()}`],
		["the end-of-options marker", () => `rm -f -- /tmp/${uniq()}`],
		["a glob in /tmp", () => "rm -f /tmp/todos*.json"],
		["a variable", () => "rm -f $TMPDIR/nope-3381"],
		["chaining", () => `rm -f /tmp/${uniq()}; ls`],
		["quotes", () => `rm -f '/tmp/${uniq()}'`],
		["a wrapper", () => `sudo rm -f /tmp/${uniq()}`],
	];
	for (const [why, cmd] of refused) {
		test(`refuses ${why}`, () => {
			expect(rmOfNothingOrOwn(cmd(), ws)).toBeNull();
		});
	}

	test("gate: the pilot shape runs without asking the judge", async () => {
		const g = await systemOneGate(`rm -f /tmp/${uniq()}.json`, process.env, ws);
		expect(g.run).toBe(true);
		expect(g.guard?.backend).toBe("allowlist");
		expect(g.guard?.reason).toContain("temp");
		expect(judge.asks).toBe(0);
	});

	test("gate: an existing temp file is still judged and blocked", async () => {
		writeFileSync(join(tmp, "todos.json"), "[]");
		const g = await systemOneGate(`rm -f ${tmp}/todos.json`, process.env, ws);
		expect(g.run).toBe(false);
		expect(judge.asks).toBe(1);
		expect(existsSync(join(tmp, "todos.json"))).toBe(true);
	});

	test("gate: /tmp/.. and /tmp-x are still judged", async () => {
		for (const cmd of ["rm -f /tmp/../etc/nope-3381", `rm -f /tmp-x-3381/${uniq()}`]) {
			const g = await systemOneGate(cmd, process.env, ws);
			expect(g.run).toBe(false);
			expect(g.guard?.backend).not.toBe("allowlist");
		}
	});

	test("gate: rm -f README.md still reaches the judge", async () => {
		writeFileSync(join(ws, "README.md"), "x");
		const g = await systemOneGate("rm -f README.md", process.env, ws);
		expect(g.run).toBe(false);
		expect(judge.asks).toBe(1);
	});

	test("ToolExecutor run_command: rm -f of an absent temp path is not System One blocked", async () => {
		const out = await new ToolExecutor(ws, "s1-rm-3381").execute("run_command", {
			command: `rm -f ${tmp}/todos.json`,
		});
		expect(out).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(judge.asks).toBe(0);
	});

	test("ToolExecutor run_command: rm -f of an existing temp file is still blocked", async () => {
		writeFileSync(join(tmp, "todos.json"), "[]");
		const out = await new ToolExecutor(ws, "s1-rm-3381").execute("run_command", {
			command: `rm -f ${tmp}/todos.json`,
		});
		expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(tmp, "todos.json"))).toBe(true);
	});
});
