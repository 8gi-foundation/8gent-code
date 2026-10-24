/**
 * #4890 slice 1: the workspace read boundary enforced by the kernel (macOS Seatbelt), behind
 * EIGHT_OS_READ_BOUNDARY=1. The lexical boundary (read-boundary.ts) stays in front and explains
 * the card; this rule is the backstop for paths a command builds while it runs.
 *
 * Three layers, so what runs where is plain:
 *   1. Pure: the spec and the generated profile, on every platform.
 *   2. The kernel's own profile compiler accepts the profile (macOS). sandbox-exec compiles before
 *      it applies: a syntax error exits 65, a compiled profile that cannot be applied (this host
 *      is already sandboxed) exits 71. Either 0 or 71 proves the rules parse.
 *   3. Live: the real run_command path (ToolExecutor) with the planted outside secret. Only where
 *      sandbox-exec can apply a profile (not nested): the macos-read-boundary workflow, which sets
 *      EIGHT_OS_READ_E2E=1 so a silent skip there is a failure.
 *
 * The fixtures sit under the repo's .tmp/, not $TMPDIR: the temp folders are a read allowance.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../eight/tools";
import { namesSecret, resetReadAllow } from "./read-allow";
import { osReadSpec } from "./read-boundary";
import {
	HOME_NEVER_READ,
	OS_READ_BOUNDARY_FLAG,
	type OsReadSpec,
	buildRunCommandProfile,
	canApplySeatbelt,
	osReadRules,
	ownPrivateFilters,
	protectedRunCommandPaths,
	snapshotSecurityEnv,
	wrapRunCommand,
} from "./run-command-sandbox";
import {
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
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
	// Real paths: the kernel matches real paths, and the profile is built from these.
	base = fs.realpathSync(fs.mkdtempSync(path.join(repoTmp, "os-read-")));
	ws = path.join(base, "proj");
	home = path.join(base, "home");
	for (const d of [
		path.join(ws, "src"),
		path.join(ws, ".data", "keys"),
		path.join(ws, ".eh", ".8gent", "keys"),
		path.join(home, ".ssh"),
		path.join(home, ".8gent", "keys"),
	])
		fs.mkdirSync(d, { recursive: true });
	const files: [string, string][] = [
		[path.join(base, "x"), "OUTSIDE-X"],
		[path.join(ws, "inside.txt"), "INSIDE-OK"],
		[path.join(ws, "package.json"), '{"name":"os-read-fixture","private":true}'],
		[path.join(ws, "src", "a.ts"), "export const a = 1;\n"],
		[
			path.join(ws, "src", "a.test.ts"),
			'import { expect, test } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n',
		],
		[path.join(home, ".ssh", "id_rsa"), "PRIVATE-KEY"],
		[path.join(home, ".8gent", "memory.db"), "MEMORY-DB"],
		[path.join(home, ".8gent", "config.json"), "OWN-CONFIG"],
		[path.join(home, ".8gent", "keys", "k"), "SIGNING-KEY"],
		[path.join(home, "notes.txt"), "HOME-NOTES"],
		[path.join(home, ".git-credentials"), "GIT-CREDENTIALS"],
		[path.join(home, ".8gent", "mv-key"), "unused"],
		[path.join(home, ".ssh", "id_mv"), "PRIVATE-MV"],
		[path.join(base, "y"), "OUTSIDE-Y"],
		// An EIGHT_DATA_DIR inside the workspace root: its keys/ must stay shut (#4132, #4890).
		[path.join(ws, ".data", "keys", "k"), "DATA-DIR-KEY"],
		// EIGHT_HOME inside the root: sensitiveCredentialPaths() does not cover its .8gent/keys.
		[path.join(ws, ".eh", ".8gent", "keys", "k"), "EIGHT-HOME-KEY"],
	];
	for (const [p, c] of files) fs.writeFileSync(p, c);
	// The protected data roots (signing keys, #4132) follow the fake home in test mode.
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
	process.env[SYSTEM_ONE_FLAG] = "0"; // System One off: the read boundaries alone decide
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
const profile = (s: OsReadSpec) => buildRunCommandProfile(protectedRunCommandPaths(), s);

/** The commands a lexical check cannot see: each builds its path while it runs (#4890). */
const GAPS_IN_WS = [
	`python3 -c "print(open('..'+'/x').read())"`,
	"cat ${OLDPWD:-..}/x",
	"awk 1 ${PWD%/*}/x",
];
/** The signing key (#4132), reached by a path built at run time. */
const SIGNING_KEY_GAP = `python3 -c "print(open('.8g'+'ent/k'+'eys/k').read())"`;
/** Rooted at the home folder: the credential and private stores, reached by built paths. */
const GAPS_IN_HOME = [
	"cat ~/.s${x:-sh}/i${x:-d}_rsa",
	`python3 -c "print(open(__import__('os').path.join(__import__('os').path.expanduser('~'),'.s'+'sh','i'+'d_rsa')).read())"`,
	`python3 -c "print(open('.8gent/'+'memory.db').read())"`,
];

// ============================================
// 1. Pure: spec and profile (every platform)
// ============================================

describe("flag and spec", () => {
	test("off by default: no spec, and the profile is byte-identical to today's", () => {
		expect(osReadSpec("cat x", { cwd: ws })).toBeUndefined();
		const p = protectedRunCommandPaths();
		expect(buildRunCommandProfile(p, undefined)).toBe(buildRunCommandProfile(p));
		expect(buildRunCommandProfile(p)).not.toContain("file-read-data");
	});

	test("a .env may turn the flag on, never off", () => {
		const declared = new Set([OS_READ_BOUNDARY_FLAG]);
		expect(snapshotSecurityEnv({ [OS_READ_BOUNDARY_FLAG]: "1" }, declared).values).toEqual({
			[OS_READ_BOUNDARY_FLAG]: "1",
		});
		const off = snapshotSecurityEnv({ [OS_READ_BOUNDARY_FLAG]: "0" }, declared);
		expect(off.values).toEqual({});
		expect(off.ignored).toEqual([OS_READ_BOUNDARY_FLAG]);
	});

	test("the root is the one the read card judges: EIGHT_WORKSPACE_ROOT, else the project", () => {
		expect(spec("cat x").root).toBe(ws);
		process.env.EIGHT_WORKSPACE_ROOT = base;
		expect(spec("cat x").root).toBe(base);
	});

	test("reads carry the allowances; homes carry HOME", () => {
		const s = spec("cat x");
		expect(s.reads).toContain("/usr/include");
		expect(s.reads).toContain(fs.realpathSync(os.tmpdir()));
		expect(s.homes).toContain(home);
		expect(s.dataRoots).toContain(path.join(home, ".8gent"));
	});

	test("a yes on the card opens exactly the outside path it named, and nothing without one", () => {
		expect(spec("cat ../x", ws, false).reads).not.toContain(path.join(base, "x"));
		expect(spec("cat ../x", ws, true).reads).toContain(path.join(base, "x"));
		// A path built at run time was never on a card, so a yes does not open it.
		expect(spec(GAPS_IN_WS[0] as string, ws, true).reads).not.toContain(path.join(base, "x"));
	});
});

describe("generated profile", () => {
	test("denies every file read, then allows the root and the system back", () => {
		const text = profile(spec("cat x"));
		const lines = text.split("\n");
		const deny = lines.indexOf("(deny file-read-data)");
		expect(lines.indexOf("(allow default)")).toBe(1);
		expect(deny).toBe(3);
		const allow = lines.findIndex((l) => l.startsWith("(allow file-read-data (require-all"));
		expect(allow).toBeGreaterThan(deny);
		const rule = lines[allow] as string;
		for (const dir of ["/usr", "/System", "/Library", "/private/etc", ws])
			expect(rule).toContain(`(subpath "${dir}")`);
		// The planted secret's folder and the home are not allowed back.
		expect(rule).not.toContain(`(subpath "${base}")`);
		expect(rule).not.toContain(`(subpath "${home}")`);
		expect(rule).toContain(`(subpath "${path.join(home, ".gitconfig")}")`);
	});

	test("the folders above the root are listable by name only (literal, not subpath)", () => {
		const lines = profile(spec("cat x")).split("\n");
		const listable = lines.find((l) => l.startsWith("(allow file-read-data (literal")) as string;
		expect(listable).toContain(`(literal "${base}")`);
		expect(listable).toContain('(literal "/")');
		expect(listable).not.toContain("subpath");
	});

	test("credential stores and the private data set are denied AFTER every allow", () => {
		const lines = profile(spec("cat x", home)).split("\n");
		const lastAllow = lines.findLastIndex((l) => l.startsWith("(allow file-read-data"));
		const secretDeny = lines.findIndex((l) => l.startsWith("(deny file-read* (literal"));
		expect(secretDeny).toBeGreaterThan(lastAllow);
		const rule = lines[secretDeny] as string;
		expect(rule).toContain(`(subpath "${path.join(home, ".ssh")}")`);
		expect(rule).toContain(`(subpath "${path.join(home, ".aws")}")`);
		// The signing-key read deny (#4132) still follows, unchanged.
		const keyDir = path.join(home, ".8gent", "keys");
		const keys = lines.findIndex(
			(l) => l.startsWith("(deny file-read*") && l.includes(`(subpath "${keyDir}")`),
		);
		expect(keys).toBeGreaterThan(lastAllow);
	});

	test("a rename out of the never-read set is denied too, after every allow", () => {
		const lines = profile(spec("cat x", home)).split("\n");
		const lastAllow = lines.findLastIndex((l) => l.startsWith("(allow file-read-data"));
		const unlink = lines.findIndex((l) => l.startsWith("(deny file-write-unlink"));
		expect(unlink).toBeGreaterThan(lastAllow);
		const rule = lines[unlink] as string;
		expect(rule).toContain(`(subpath "${path.join(home, ".ssh")}")`);
		expect(rule).toContain(`(subpath "${path.join(home, ".8gent", "browser-profiles")}")`);
		expect(rule).toContain("(regex #");
	});

	test("the never-read set holds every credential store the text boundary calls secret", () => {
		const rule = profile(spec("cat x", home));
		for (const rel of HOME_NEVER_READ)
			expect(rule).toContain(`(subpath "${path.join(home, rel)}")`);
		// and each of those the text boundary names as secret really is in the list
		for (const rel of [
			".git-credentials",
			".config/op",
			".azure",
			".pgpass",
			".local/share/keyrings",
		])
			expect(namesSecret(path.join(home, rel))).toBe(true);
	});

	test("the private data regexes match what OWN_PRIVATE names, in any case, and nothing else", () => {
		const root = path.join(home, ".8gent");
		const res = ownPrivateFilters(root).map((f) => {
			const m = /^\(regex #"(.*)"\)$/.exec(f);
			if (!m) throw new Error(`not a regex filter: ${f}`);
			return new RegExp((m[1] as string).replaceAll("\\\\", "\\"));
		});
		const denied = (p: string) => res.some((r) => r.test(path.join(root, p)));
		for (const p of [
			"memory.db",
			"MEMORY.DB",
			"brain.sqlite",
			"memory/index",
			"clients/acme/notes.md",
			"browser-profiles/default/Cookies",
			"audit.jsonl",
			"backups/2026.tar",
			"cron-jobs.json",
			"telegram-bot.json",
			"sessions/abc.json",
			"browser-control.token",
			".env",
			"keys.env",
			"credentials.json",
			"certs/client.pem",
			"x/y/z.db-wal",
			"keys/state-hmac.key",
			"KEYS/k",
			"secrets/telegram",
		])
			expect({ p, denied: denied(p) }).toEqual({ p, denied: true });
		for (const p of ["config.json", "settings.json", "skills/a/SKILL.md", "themes/dark.json"])
			expect({ p, denied: denied(p) }).toEqual({ p, denied: false });
	});

	test("an EIGHT_DATA_DIR inside the root: its keys/ and secrets/ are excluded inside the allow", () => {
		const dataDir = path.join(ws, ".data");
		process.env.EIGHT_DATA_DIR = dataDir;
		const lines = profile(spec("cat x")).split("\n");
		const allow = lines.find((l) => l.startsWith("(allow file-read-data (require-all")) as string;
		const never = allow.slice(allow.indexOf("(require-not"));
		// The root allow covers the data dir; the exclusion inside the same rule shuts its key dirs.
		expect(allow.slice(0, allow.indexOf("(require-not"))).toContain(`(subpath "${ws}")`);
		expect(never).toContain(`(subpath "${path.join(dataDir, "keys")}")`);
		expect(never).toContain(`(subpath "${path.join(dataDir, "secrets")}")`);
	});

	test("an EIGHT_HOME inside the root: its .8gent/keys/ is excluded inside the allow", () => {
		process.env.EIGHT_HOME = path.join(ws, ".eh");
		const lines = profile(spec("cat x")).split("\n");
		const allow = lines.find((l) => l.startsWith("(allow file-read-data (require-all")) as string;
		const never = allow.slice(allow.indexOf("(require-not"));
		expect(never).toContain(`(subpath "${path.join(ws, ".eh", ".8gent", "keys")}")`);
		expect(never).toContain(`(subpath "${path.join(ws, ".eh", ".8gent", "secrets")}")`);
	});

	test("osReadRules refuses a relative root", () => {
		expect(() => osReadRules({ root: "proj", reads: [], dataRoots: [], homes: [] })).toThrow(
			/root must be absolute/,
		);
	});

	test("a PATH entry that is or holds a home never opens the home", () => {
		const rules = osReadRules(
			{ root: ws, reads: [], dataRoots: [], homes: [home] },
			[home, path.dirname(home), "/", path.join(home, ".bun", "bin")].join(path.delimiter),
		).join("\n");
		expect(rules).not.toContain(`(subpath "${home}")`);
		expect(rules).not.toContain(`(subpath "${base}")`);
		expect(rules).toContain(`(subpath "${path.join(home, ".bun", "bin")}")`);
		expect(rules).toContain(`(subpath "${path.join(home, ".bun", "lib")}")`);
	});

	test("wrapRunCommand carries the rule only when the flag is on", () => {
		const s = spec("cat x");
		const wrappedOn = wrapRunCommand("cat x", s);
		Reflect.deleteProperty(process.env, OS_READ_BOUNDARY_FLAG);
		const wrappedOff = wrapRunCommand("cat x", s);
		// Here sandbox-exec may not apply (nested host): then both are the bare command.
		if (canApplySeatbelt()) {
			expect(wrappedOn).toContain("(deny file-read-data)");
			expect(wrappedOff).not.toContain("(deny file-read-data)");
		} else {
			expect(wrappedOn).toBe("cat x");
			expect(wrappedOff).toBe("cat x");
		}
	});
});

describe("the known gaps still pass the lexical boundary (so only the kernel can stop them)", () => {
	const lexical = async (command: string, root: string) => {
		const r = await systemOneGate(
			command,
			{ ...process.env, HOME: home },
			root,
			undefined,
			undefined,
			{
				project: root,
			},
		);
		return r.run ? "ran" : "refused";
	};
	for (const command of GAPS_IN_WS)
		test(`lexically runs in the project: ${command}`, async () => {
			expect(await lexical(command, ws)).toBe("ran");
			expect(cards).toEqual([]);
		});
	for (const command of GAPS_IN_HOME)
		test(`lexically runs rooted at home: ${command}`, async () => {
			expect(await lexical(command, home)).toBe("ran");
			expect(cards).toEqual([]);
		});
});

// ============================================
// 2. The kernel's profile compiler accepts it (macOS)
// ============================================

const hasSandboxExec = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

describe.if(hasSandboxExec)("sandbox-exec compiles the generated profile", () => {
	for (const [name, root] of [
		["project root", () => ws],
		["home root", () => home],
	] as const)
		test(name, () => {
			const text = profile(spec("cat ../x", root(), true));
			const r = spawnSync("/usr/bin/sandbox-exec", ["-p", text, "/usr/bin/true"], {
				encoding: "utf8",
			});
			// 65: the compiler refused the profile. 71: compiled, but this host cannot apply it (nested).
			expect({ status: r.status, stderr: r.stderr }).toEqual({
				status: canApplySeatbelt() ? 0 : 71,
				stderr: canApplySeatbelt() ? "" : "sandbox-exec: sandbox_apply: Operation not permitted\n",
			});
		});
});

// ============================================
// 3. Live, through the real run_command path (macOS CI)
// ============================================

const required = process.env.EIGHT_OS_READ_E2E === "1";
const live = canApplySeatbelt();

test("the live suite runs where it is required", () => {
	// The macos-read-boundary workflow sets EIGHT_OS_READ_E2E=1: a skip there is a failure.
	if (required) expect(live).toBe(true);
});

const run = (root: string, command: string) =>
	new ToolExecutor(root).execute("run_command", { command }) as Promise<string>;

// Runs on any POSIX host, sandboxed or not: the gaps are real on the shipping path. With the flag
// off, run_command reads the planted secret, so the refusals below are the kernel rule's doing.
describe.if(process.platform !== "win32")(
	"control, flag off: run_command reads the planted secret",
	() => {
		for (const command of GAPS_IN_WS)
			test(command, async () => {
				expect(await run(ws, command)).toContain("OUTSIDE-X");
			});
		for (const command of GAPS_IN_HOME)
			test(`rooted at home: ${command}`, async () => {
				expect(await run(home, command)).toMatch(/PRIVATE-KEY|MEMORY-DB/);
			});
		// No text check stops it. Where Seatbelt applies, the #4132 rule already shuts the key.
		test(`rooted at home: ${SIGNING_KEY_GAP}`, async () => {
			const out = await run(home, SIGNING_KEY_GAP);
			if (canApplySeatbelt()) expectKernelRefusal(out);
			else expect(out).toContain("SIGNING-KEY");
		});
	},
);

/** The command ran (no text check stopped it) and the read was refused by the OS. */
const expectKernelRefusal = (out: string) => {
	expect(out).not.toContain("[BLOCKED]");
	expect(out).toMatch(/Operation not permitted|PermissionError|can't open file/);
};

describe.if(live)("live: run_command under the kernel read rule (macOS)", () => {
	for (const command of GAPS_IN_WS) {
		test(`flag on: the kernel refuses it: ${command}`, async () => {
			on();
			const out = await run(ws, command);
			expect(out).not.toContain("OUTSIDE-X");
			expectKernelRefusal(out);
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

	test("flag on, rooted at home: credential stores the text boundary calls secret stay shut", async () => {
		on();
		const out = await run(home, `python3 -c "print(open('.git-cre'+'dentials').read())"`);
		expect(out).not.toContain("GIT-CREDENTIALS");
		expectKernelRefusal(out);
	});

	test("flag on: a credential cannot be moved into the root and read there (8SO probe)", async () => {
		on();
		const key = path.join(home, ".ssh", "id_mv");
		const cmd = `python3 -c "import os;os.rename('/'.join([os.path.expanduser('~'),'.ss'+'h','id_mv']),'moved');print(open('moved').read())"`;
		const out = await run(ws, cmd);
		expect(out).not.toContain("PRIVATE-MV");
		expect(fs.existsSync(key)).toBe(true); // the rename itself was refused, nothing left home
		expect(fs.existsSync(path.join(ws, "moved"))).toBe(false);
	});

	test("known gap: a non-credential outside file can still be moved into the root and read", async () => {
		on();
		const out = await run(
			ws,
			`python3 -c "import os;os.rename(os.path.join('..','y'),'moved-y');print(open('moved-y').read())"`,
		);
		// Pinned so that closing the gap has to move this test: today the rename is allowed.
		expect(out).toContain("OUTSIDE-Y");
	});

	test("flag on, rooted at home: ordinary home files and own config still read", async () => {
		on();
		const out = await run(home, "cat notes.txt .8gent/config.json");
		expect(out).toContain("HOME-NOTES");
		expect(out).toContain("OWN-CONFIG");
	});

	test("flag on: the signing key stays shut (#4132)", async () => {
		on();
		const out = await run(home, SIGNING_KEY_GAP);
		expect(out).not.toContain("SIGNING-KEY");
		expectKernelRefusal(out);
	});

	test("flag on: an EIGHT_DATA_DIR inside the root keeps its keys/ shut", async () => {
		on();
		process.env.EIGHT_DATA_DIR = path.join(ws, ".data");
		const out = await run(ws, `python3 -c "print(open('.da'+'ta/ke'+'ys/k').read())"`);
		expect(out).not.toContain("DATA-DIR-KEY");
		expectKernelRefusal(out);
		// A positive control in the same data dir: the root is readable, only the key dir is not.
		expect(await run(ws, "cat inside.txt")).toContain("INSIDE-OK");
	});

	test("flag on: an EIGHT_HOME inside the root keeps its .8gent/keys/ shut", async () => {
		on();
		process.env.EIGHT_HOME = path.join(ws, ".eh");
		const out = await run(ws, `python3 -c "print(open('.e'+'h/.8g'+'ent/ke'+'ys/k').read())"`);
		expect(out).not.toContain("EIGHT-HOME-KEY");
		expectKernelRefusal(out);
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
		// The real home for these: a person's tools (bun, git config) live there.
		const realHome = () => {
			process.env.HOME = saved.HOME ?? os.homedir();
		};

		test("cat package.json", async () => {
			on();
			realHome();
			expect(await run(ws, "cat package.json")).toContain("os-read-fixture");
		});

		test("git log", async () => {
			on();
			realHome();
			expect(await run(ws, "git log --oneline")).toContain("fixture");
		});

		test("rg", async () => {
			on();
			realHome();
			const hasRg = spawnSync("rg", ["--version"]).status === 0;
			// CI installs ripgrep; a host without it has nothing to prove here.
			if (required) expect(hasRg).toBe(true);
			if (!hasRg) return;
			expect(await run(ws, "rg export src")).toContain("export const a");
		});

		test("bun test", async () => {
			on();
			realHome();
			const out = await run(ws, "bun test src/a.test.ts");
			expect(out).toMatch(/1 pass/);
			expect(out).not.toMatch(/Operation not permitted/);
		});

		test("python3 inside the root", async () => {
			on();
			realHome();
			expect(await run(ws, `python3 -c "print(open('inside.txt').read())"`)).toContain("INSIDE-OK");
		});
	});
});
