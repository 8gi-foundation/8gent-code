/**
 * #4890 slice 2: the workspace read boundary in the Linux kernel (Landlock), behind
 * EIGHT_OS_READ_BOUNDARY=1. Same fixtures and the same live commands as slice 1
 * (os-read-boundary.test.ts, macOS), plus the moves Landlock can refuse that Seatbelt could not.
 *
 * Three layers:
 *   1. Pure, every platform: the grant lists, the never-read set, the honest fallback line, and
 *      the helper's Python parses (its plan parser runs too; no syscall is reached).
 *   2. Live, through the real run_command path (ToolExecutor), wherever the Landlock probe
 *      passes. The linux-read-boundary workflow sets EIGHT_OS_READ_E2E_LINUX=1 so a skip there
 *      is a failure, and runs the file twice: Landlock alone, and Landlock under bwrap.
 *
 * The fixtures sit under the repo's .tmp/, not $TMPDIR: the temp folders are a read allowance.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import {
	LANDLOCK_HELPER,
	_resetLandlockStatus,
	inPrivateDataSet,
	landlockPlan,
	landlockPython,
	landlockShell,
	landlockStatus,
} from "./landlock";
import { resetReadAllow } from "./read-allow";
import { osReadSpec } from "./read-boundary";
import {
	OS_READ_BOUNDARY_FLAG,
	type OsReadSpec,
	_resetReadRuleWarning,
	linuxReadPlan,
	linuxReadPrefix,
	ownPrivateFilters,
	wrapRunCommand,
} from "./run-command-sandbox";
import {
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
} from "./system-one-gate";

const repoTmp = path.resolve(import.meta.dir, "..", "..", ".tmp");
let base: string;
let ws: string;
let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = [
	"HOME",
	"EIGHT_FAKE_HOME",
	OS_READ_BOUNDARY_FLAG,
	SYSTEM_ONE_FLAG,
	"EIGHT_WORKSPACE_ROOT",
	"EIGHT_DATA_DIR",
	"EIGHT_HOME",
];
let cards: string[] = [];
let answer: boolean | null = null;

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	fs.mkdirSync(repoTmp, { recursive: true });
	base = fs.realpathSync(fs.mkdtempSync(path.join(repoTmp, "os-read-linux-")));
	ws = path.join(base, "proj");
	home = path.join(base, "home");
	for (const d of [
		path.join(ws, "src"),
		path.join(ws, ".data", "keys"),
		path.join(ws, ".eh", ".8gent", "keys"),
		path.join(home, ".ssh"),
		path.join(home, ".8gent", "keys"),
		path.join(home, ".8gent", "skills", "one"),
		path.join(home, ".8gent", "skills", "two"),
		path.join(home, ".config", "gcloud"),
		path.join(home, ".config", "app"),
		path.join(home, "code"),
		path.join(base, "other"),
	])
		fs.mkdirSync(d, { recursive: true });
	const files: [string, string][] = [
		[path.join(base, "x"), "OUTSIDE-X"],
		[path.join(base, "y"), "OUTSIDE-Y"],
		[path.join(base, "other", "z"), "OUTSIDE-Z"],
		[path.join(ws, "inside.txt"), "INSIDE-OK"],
		[path.join(ws, "package.json"), '{"name":"os-read-fixture","private":true}'],
		[path.join(ws, "src", "a.ts"), "export const a = 1;\n"],
		[
			path.join(ws, "src", "a.test.ts"),
			'import { expect, test } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n',
		],
		[path.join(ws, ".data", "keys", "k"), "DATA-DIR-KEY"],
		[path.join(ws, ".eh", ".8gent", "keys", "k"), "EIGHT-HOME-KEY"],
		[path.join(home, ".ssh", "id_rsa"), "PRIVATE-KEY"],
		[path.join(home, ".ssh", "id_mv"), "PRIVATE-MV"],
		[path.join(home, ".8gent", "memory.db"), "MEMORY-DB"],
		[path.join(home, ".8gent", "config.json"), "OWN-CONFIG"],
		[path.join(home, ".8gent", "keys", "k"), "SIGNING-KEY"],
		[path.join(home, ".8gent", "skills", "one", "SKILL.md"), "SKILL-ONE"],
		[path.join(home, ".8gent", "skills", "two", "cache.db"), "SKILL-DB"],
		[path.join(home, ".8gent", "skills", "two", "SKILL.md"), "SKILL-TWO"],
		[path.join(home, ".config", "gcloud", "credentials.db"), "GCLOUD"],
		[path.join(home, ".config", "app", "settings"), "APP-SETTINGS"],
		[path.join(home, "notes.txt"), "HOME-NOTES"],
		[path.join(home, "code", "main.c"), "HOME-CODE"],
		[path.join(home, ".git-credentials"), "GIT-CREDENTIALS"],
	];
	for (const [p, c] of files) fs.writeFileSync(p, c);
	// A link planted in the home before the session, pointing into a credential store.
	fs.symlinkSync(".ssh", path.join(home, "sshlink"));
	process.env.EIGHT_FAKE_HOME = home;
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
	resetReadAllow();
	fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
	cards = [];
	answer = null;
	Reflect.deleteProperty(process.env, OS_READ_BOUNDARY_FLAG);
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, "EIGHT_DATA_DIR");
	Reflect.deleteProperty(process.env, "EIGHT_HOME");
	process.env.HOME = home;
	process.env[SYSTEM_ONE_FLAG] = "0";
	_setSystemOneOverridesForTests({
		askHuman: async (req) => {
			cards.push(req.command);
			return answer;
		},
	});
});

const on = () => {
	process.env[OS_READ_BOUNDARY_FLAG] = "1";
};
const spec = (command: string, root = ws, approved = false): OsReadSpec => {
	on();
	const s = osReadSpec(command, { cwd: root, project: root, approved });
	if (!s) throw new Error("osReadSpec returned undefined with the flag on");
	return s;
};

/** Slice 1's commands a lexical check cannot see. */
const GAPS_IN_WS = [
	`python3 -c "print(open('..'+'/x').read())"`,
	"cat ${OLDPWD:-..}/x",
	"awk 1 ${PWD%/*}/x",
];
const SIGNING_KEY_GAP = `python3 -c "print(open('.8g'+'ent/k'+'eys/k').read())"`;
const GAPS_IN_HOME = [
	"cat ~/.s${x:-sh}/i${x:-d}_rsa",
	`python3 -c "print(open(__import__('os').path.join(__import__('os').path.expanduser('~'),'.s'+'sh','i'+'d_rsa')).read())"`,
	`python3 -c "print(open('.8gent/'+'memory.db').read())"`,
];

// ============================================
// 1. Pure (every platform)
// ============================================

describe("grant lists", () => {
	const plan = (root: string) => linuxReadPlan(spec("cat x", root), "/usr/bin:/bin");
	const covers = (grants: string[], p: string) =>
		grants.some((g) => p === g || p.startsWith(`${g}/`));

	test("a project root is granted whole; the home and the outside are not", () => {
		const { read } = plan(ws);
		expect(read).toContain(ws);
		expect(covers(read, path.join(base, "x"))).toBe(false);
		expect(covers(read, home)).toBe(false);
		expect(covers(read, path.join(home, ".ssh", "id_rsa"))).toBe(false);
	});

	test("rooted at home: the home is never granted whole, only its entries minus the never-read set", () => {
		const { read } = plan(home);
		expect(read).not.toContain(home);
		expect(covers(read, path.join(home, "notes.txt"))).toBe(true);
		expect(covers(read, path.join(home, "code", "main.c"))).toBe(true);
		expect(covers(read, path.join(home, ".config", "app", "settings"))).toBe(true);
		for (const shut of [
			".ssh/id_rsa",
			".git-credentials",
			".config/gcloud/credentials.db",
			".8gent/memory.db",
			".8gent/keys/k",
			".8gent/skills/two/cache.db",
		])
			expect({ shut, covered: covers(read, path.join(home, shut)) }).toEqual({
				shut,
				covered: false,
			});
		// The folders that hold a never-read entry are split, not granted.
		for (const split of [".config", ".8gent", ".8gent/skills/two"])
			expect(read).not.toContain(path.join(home, split));
	});

	test("inside a data root a clean folder is granted whole, one holding a database is split", () => {
		const { read } = plan(home);
		expect(read).toContain(path.join(home, ".8gent", "skills", "one"));
		expect(read).toContain(path.join(home, ".8gent", "skills", "two", "SKILL.md"));
		expect(read).toContain(path.join(home, ".8gent", "config.json"));
	});

	test("a link in a split folder is never granted (the kernel would grant its target)", () => {
		const { read, remove } = plan(home);
		expect(read).not.toContain(path.join(home, "sshlink"));
		expect(remove).not.toContain(path.join(home, "sshlink"));
	});

	test("remove and rename are granted everywhere except the folders that hold a never-read path", () => {
		const { remove } = plan(ws);
		expect(covers(remove, ws)).toBe(true);
		expect(covers(remove, path.join(home, "code"))).toBe(true);
		expect(remove).toContain(path.join(base, "other"));
		for (const shut of [home, path.join(home, ".ssh"), path.join(home, ".8gent"), "/"])
			expect({ shut, granted: remove.includes(shut) }).toEqual({ shut, granted: false });
		expect(covers(remove, path.join(home, ".ssh", "id_rsa"))).toBe(false);
		expect(covers(remove, path.join(home, ".8gent", "memory.db"))).toBe(false);
	});

	test("an EIGHT_DATA_DIR or EIGHT_HOME inside the root: the root is split around its keys/", () => {
		process.env.EIGHT_DATA_DIR = path.join(ws, ".data");
		process.env.EIGHT_HOME = path.join(ws, ".eh");
		const { read } = plan(ws);
		expect(read).not.toContain(ws);
		expect(covers(read, path.join(ws, "inside.txt"))).toBe(true);
		expect(covers(read, path.join(ws, ".data", "keys", "k"))).toBe(false);
		expect(covers(read, path.join(ws, ".eh", ".8gent", "keys", "k"))).toBe(false);
	});

	test("past the walk budget a data-root folder is left shut, never opened", () => {
		const dr = path.join(home, ".8gent");
		const p = landlockPlan([dr], [], [dr], 3);
		const skills = path.join(dr, "skills");
		const inSkills = (g: string) => g === skills || g.startsWith(`${skills}/`);
		expect(p.read.some(inSkills)).toBe(false);
		expect(p.remove.some(inSkills)).toBe(false);
		// The cut is local: the data root's own top level is listed whatever the budget.
		expect(p.read).toContain(path.join(dr, "config.json"));
	});

	test("the private data set matches slice 1's Seatbelt regexes", () => {
		const root = path.join(home, ".8gent");
		const res = ownPrivateFilters(root).map(
			(f) => new RegExp((f.match(/^\(regex #"(.*)"\)$/) as RegExpMatchArray)[1] as string),
		);
		for (const rel of [
			"memory.db",
			"MEMORY",
			"brain-x",
			"clients/a",
			"browser-profiles/p",
			"audit.jsonl",
			"backups/a",
			"cron.json",
			"keys/k",
			"secrets",
			"telegram-bot",
			"sessions/s",
			"bot-token",
			".env",
			"x.env",
			"credentials.json",
			"skills/a/b.sqlite3",
			"x/y.PEM",
			"config.json",
			"skills/one/SKILL.md",
			"bin/tool",
		]) {
			const p = path.join(root, rel);
			expect({ rel, linux: inPrivateDataSet(p, [root]) }).toEqual({
				rel,
				linux: res.some((r) => r.test(p)),
			});
		}
	});

	test("osReadRules' relative-root refusal holds here too", () => {
		expect(() => linuxReadPlan({ root: "rel", reads: [], dataRoots: [], homes: [] })).toThrow(
			/must be absolute/,
		);
	});
});

describe("the honest line when the rule cannot be applied", () => {
	test("flag off or no spec: nothing, no line", () => {
		expect(linuxReadPrefix(undefined, "linux", () => ({ active: false, reason: "x" }))).toBe(
			undefined,
		);
	});

	test("macOS never takes this path (slice 1 is Seatbelt)", () => {
		const s = spec("cat x");
		expect(linuxReadPrefix(s, "darwin", () => ({ active: true, python: "/p", abi: 4 }))).toBe(
			undefined,
		);
	});

	test("Landlock missing: the command is not wrapped, and one plain line says so", () => {
		const s = spec("cat x");
		const writes: string[] = [];
		const orig = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			_resetReadRuleWarning();
			const probe = () =>
				({ active: false, reason: "this kernel does not support Landlock" }) as const;
			expect(linuxReadPrefix(s, "android", probe)).toBe(undefined);
			expect(linuxReadPrefix(s, "android", probe)).toBe(undefined);
		} finally {
			process.stderr.write = orig;
		}
		expect(writes).toEqual([
			"[8gent] The OS read rule (EIGHT_OS_READ_BOUNDARY=1) is not active here: this kernel does not support Landlock. Reads outside the workspace are stopped by text checks only.\n",
		]);
	});

	test("active: the helper and the grant lists go in front of the shell", () => {
		const s = spec("cat x");
		const argv = linuxReadPrefix(s, "linux", () => ({
			active: true,
			python: "/usr/bin/python3",
			abi: 4,
		}));
		expect(argv?.slice(0, 5)).toEqual(["/usr/bin/python3", "-I", "-S", "-c", LANDLOCK_HELPER]);
		expect(argv?.[5]).toBe("R");
		expect(argv?.at(-1)).toBe("--");
		expect(argv).toContain(ws);
		expect(argv).toContain("W");
	});

	test("not Linux: the probe says so without running anything", () => {
		_resetLandlockStatus();
		expect(landlockStatus("win32")).toEqual({ active: false, reason: "no Landlock on win32" });
		_resetLandlockStatus();
	});

	test("python3 and the shell are found at fixed places, Termux's prefix included", () => {
		const termux = "/data/data/com.termux/files/usr";
		const only = (p: string) => (q: string) => q === p;
		expect(landlockPython({ PREFIX: termux }, only(`${termux}/bin/python3`))).toBe(
			`${termux}/bin/python3`,
		);
		expect(landlockPython({}, only("/usr/bin/python3"))).toBe("/usr/bin/python3");
		// Never from PATH: a workspace can put its own python3 first there.
		expect(landlockPython({ PATH: "/evil" }, only("/evil/python3"))).toBe(undefined);
		expect(landlockShell(only(`${termux}/bin/sh`))).toBe(`${termux}/bin/sh`);
	});
});

const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;

describe.if(hasPython)("the helper (Python)", () => {
	test("parses", () => {
		const r = spawnSync(
			"python3",
			["-c", "import sys; compile(sys.stdin.read(), 'helper', 'exec')"],
			{
				input: LANDLOCK_HELPER,
				encoding: "utf8",
			},
		);
		expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
	});

	test("a plan with no command never runs anything: exit 126 with a message", () => {
		const r = spawnSync("python3", ["-I", "-S", "-c", LANDLOCK_HELPER, "R", "/tmp"], {
			encoding: "utf8",
		});
		expect(r.status).toBe(126);
		expect(r.stderr).toContain("could not be applied, so the command did not run: no command");
	});

	test("a malformed plan never runs anything", () => {
		const r = spawnSync(
			"python3",
			["-I", "-S", "-c", LANDLOCK_HELPER, "/tmp", "--", "/bin/echo", "RAN"],
			{
				encoding: "utf8",
			},
		);
		expect(r.status).toBe(126);
		expect(r.stdout).not.toContain("RAN");
	});
});

// ============================================
// 2. Live, through the real run_command path (Linux with Landlock)
// ============================================

const required = process.env.EIGHT_OS_READ_E2E_LINUX === "1";
const live = process.platform === "linux" && landlockStatus().active;

test("the live suite runs where it is required", () => {
	// The linux-read-boundary workflow sets EIGHT_OS_READ_E2E_LINUX=1: a skip there is a failure.
	if (required) expect({ live, status: landlockStatus() }).toMatchObject({ live: true });
});

const run = (root: string, command: string) =>
	new ToolExecutor(root).execute("run_command", { command }) as Promise<string>;

/** Straight to the kernel (wrapRunCommand, no text boundary): only the rule decides. */
const direct = (root: string, command: string) => {
	const r = spawnSync("/bin/sh", ["-c", wrapRunCommand(command, spec(command, root))], {
		cwd: root,
		encoding: "utf8",
	});
	return `${r.stdout}${r.stderr}`;
};

/** The command ran (no text check stopped it) and the read was refused by the OS. */
const expectKernelRefusal = (out: string) => {
	expect(out).not.toContain("[BLOCKED]");
	expect(out).not.toContain("could not be applied");
	expect(out).toMatch(/Permission denied|PermissionError|cannot open/);
};

/**
 * The keys/ folders: under bwrap (the write boundary) they are covered by an empty tmpfs first,
 * so the read finds nothing (ENOENT) before Landlock is asked. Either way the key is not read;
 * the Landlock-alone run proves the Landlock refusal.
 */
const expectKeyRefusal = (out: string) => {
	if (process.env.EIGHT_OS_READ_E2E_BWRAP === "1") {
		expect(out).not.toContain("[BLOCKED]");
		expect(out).toMatch(/Permission denied|PermissionError|No such file|FileNotFoundError/);
	} else expectKernelRefusal(out);
};

describe.if(live)("live: run_command under the Landlock read rule", () => {
	test("the command runs under the helper (and under bwrap where the job installed it)", () => {
		on();
		const w = wrapRunCommand("true", spec("true"));
		expect(w).toContain("landlock_restrict_self");
		if (process.env.EIGHT_OS_READ_E2E_BWRAP === "1") expect(w).toMatch(/^'[^']*\/bwrap' /);
		else expect(w).not.toContain("bwrap");
	});

	for (const command of GAPS_IN_WS) {
		test(`flag on: the kernel refuses it: ${command}`, async () => {
			on();
			const out = await run(ws, command);
			expect(out).not.toContain("OUTSIDE-X");
			expectKernelRefusal(out);
		});
		test(`flag off (control): it reads: ${command}`, async () => {
			expect(await run(ws, command)).toContain("OUTSIDE-X");
		});
	}

	for (const command of GAPS_IN_HOME) {
		test(`flag on, rooted at home: the credential and private stores stay shut: ${command}`, async () => {
			on();
			const out = await run(home, command);
			expect(out).not.toMatch(/PRIVATE-KEY|MEMORY-DB/);
			expectKernelRefusal(out);
		});
	}

	test("flag on, rooted at home: stores the text boundary calls secret stay shut", async () => {
		on();
		for (const p of [`'.git-cre'+'dentials'`, `'.config/gc'+'loud/credentials.db'`]) {
			const out = await run(home, `python3 -c "print(open(${p}).read())"`);
			expect(out).not.toMatch(/GIT-CREDENTIALS|GCLOUD/);
			expectKernelRefusal(out);
		}
	});

	test("flag on, rooted at home: a link planted in the home does not reach the store", async () => {
		on();
		const out = await run(home, `python3 -c "print(open('ssh'+'link/id_rsa').read())"`);
		expect(out).not.toContain("PRIVATE-KEY");
		expectKernelRefusal(out);
	});

	test("flag on, rooted at home: a link the command makes does not reach the store either", () => {
		on();
		const out = direct(home, "ln -s .ssh/id_rsa made-link && cat made-link; rm -f made-link");
		expect(out).not.toContain("PRIVATE-KEY");
		expect(out).toMatch(/Permission denied/);
	});

	test("flag on: a credential cannot be moved into the root and read there (8SO probe)", () => {
		on();
		const key = path.join(home, ".ssh", "id_mv");
		const out = direct(ws, `mv ${key} moved && cat moved`);
		expect(out).not.toContain("PRIVATE-MV");
		expect(out).toMatch(/Permission denied|cross-device/);
		expect(fs.existsSync(key)).toBe(true);
		expect(fs.existsSync(path.join(ws, "moved"))).toBe(false);
	});

	test("flag on: nor copied, nor hard-linked", () => {
		on();
		const key = path.join(home, ".ssh", "id_mv");
		const out = direct(ws, `cp ${key} copied; cat copied; ln ${key} linked; cat linked`);
		expect(out).not.toContain("PRIVATE-MV");
		expect(out).toMatch(/Permission denied/);
		expect(out).toMatch(/cross-device|Permission denied/);
		expect(fs.existsSync(path.join(ws, "linked"))).toBe(false);
	});

	test("flag on: a move inside the root still works (control: the kernel runs mv)", () => {
		on();
		const out = direct(
			ws,
			"mv inside.txt src/moved.txt && cat src/moved.txt && mv src/moved.txt inside.txt",
		);
		expect(out).toContain("INSIDE-OK");
		expect(fs.existsSync(path.join(ws, "inside.txt"))).toBe(true);
	});

	test("flag on: a non-credential outside file cannot be moved into the root either (#4894 item 3)", async () => {
		on();
		const out = await run(
			ws,
			`python3 -c "import os;os.rename(os.path.join('..','y'),'moved-y');print(open('moved-y').read())"`,
		);
		// On macOS this is a pinned gap; Landlock refuses a move that would gain read access.
		expect(out).not.toContain("OUTSIDE-Y");
		expect(out).toMatch(/cross-device|Errno 18|Permission denied/);
		expect(fs.existsSync(path.join(base, "y"))).toBe(true);
	});

	test("flag on: nor from an outside folder the command may remove in (the move would gain read)", async () => {
		on();
		// base/other holds no never-read path, so it keeps the remove and rename grant; only
		// Landlock's rule that a move must not gain access stops this (EXDEV).
		const out = await run(
			ws,
			`python3 -c "import os;os.rename(os.path.join('..','other','z'),'moved-z');print(open('moved-z').read())"`,
		);
		expect(out).not.toContain("OUTSIDE-Z");
		expect(out).toMatch(/cross-device|Errno 18/);
		expect(fs.existsSync(path.join(base, "other", "z"))).toBe(true);
	});

	test("flag on, rooted at home: a credential store cannot be renamed to a readable name", async () => {
		on();
		const out = await run(home, `python3 -c "import os;os.rename('.s'+'sh','sshx')"`);
		expect(out).toMatch(/Permission denied|PermissionError/);
		expect(fs.existsSync(path.join(home, ".ssh", "id_rsa"))).toBe(true);
		const db = await run(
			home,
			`python3 -c "import os;os.rename('.8gent/mem'+'ory.db','.8gent/notes')"`,
		);
		expect(db).toMatch(/Permission denied|PermissionError/);
		expect(fs.existsSync(path.join(home, ".8gent", "memory.db"))).toBe(true);
	});

	test("flag on, rooted at home: ordinary home files and own config still read", async () => {
		on();
		const out = await run(
			home,
			"cat notes.txt code/main.c .8gent/config.json .8gent/skills/two/SKILL.md",
		);
		for (const want of ["HOME-NOTES", "HOME-CODE", "OWN-CONFIG", "SKILL-TWO"])
			expect(out).toContain(want);
	});

	test("flag on, rooted at home: the stated cost, the home folder itself cannot be listed", async () => {
		on();
		const out = await run(home, "ls .; ls code");
		expect(out).toMatch(/Permission denied/);
		expect(out).toContain("main.c");
	});

	test("flag on: the signing key stays shut (#4132)", async () => {
		on();
		const out = await run(home, SIGNING_KEY_GAP);
		expect(out).not.toContain("SIGNING-KEY");
		expectKeyRefusal(out);
	});

	test("flag on: an EIGHT_DATA_DIR inside the root keeps its keys/ shut", async () => {
		on();
		process.env.EIGHT_DATA_DIR = path.join(ws, ".data");
		const out = await run(ws, `python3 -c "print(open('.da'+'ta/ke'+'ys/k').read())"`);
		expect(out).not.toContain("DATA-DIR-KEY");
		expectKeyRefusal(out);
		expect(await run(ws, "cat inside.txt")).toContain("INSIDE-OK");
	});

	test("flag on: an EIGHT_HOME inside the root keeps its .8gent/keys/ shut", async () => {
		on();
		process.env.EIGHT_HOME = path.join(ws, ".eh");
		const out = await run(ws, `python3 -c "print(open('.e'+'h/.8g'+'ent/ke'+'ys/k').read())"`);
		expect(out).not.toContain("EIGHT-HOME-KEY");
		expectKeyRefusal(out);
	});

	test("flag on: a yes on the read card opens the path it named", async () => {
		on();
		answer = true;
		const out = await run(ws, "cat ../x");
		expect(cards.length).toBeGreaterThan(0);
		expect(out).toContain("OUTSIDE-X");
	});

	describe("the false-positive set still runs with the flag on", () => {
		beforeAll(() => {
			const git = (...args: string[]) =>
				spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
					cwd: ws,
					encoding: "utf8",
				});
			git("init", "-q");
			git("add", "-A");
			git("commit", "-qm", "fixture");
		});
		const realHome = () => {
			process.env.HOME = saved.HOME ?? os.homedir();
		};

		test("cat package.json", async () => {
			on();
			realHome();
			expect(await run(ws, "cat package.json")).toContain("os-read-fixture");
		});

		test("git log and git status", async () => {
			on();
			realHome();
			expect(await run(ws, "git log --oneline")).toContain("fixture");
			expect(await run(ws, "git status --short; echo STATUS-RC=$?")).toContain("STATUS-RC=0");
		});

		test("rg", async () => {
			on();
			realHome();
			const hasRg = spawnSync("rg", ["--version"]).status === 0;
			if (required) expect(hasRg).toBe(true);
			if (!hasRg) return;
			expect(await run(ws, "rg export src")).toContain("export const a");
		});

		test("bun test", async () => {
			on();
			realHome();
			const out = await run(ws, "bun test src/a.test.ts");
			expect(out).toMatch(/1 pass/);
			expect(out).not.toMatch(/Permission denied|EACCES/);
		});

		test("python3 inside the root", async () => {
			on();
			realHome();
			expect(await run(ws, `python3 -c "print(open('inside.txt').read())"`)).toContain("INSIDE-OK");
		});
	});
});
