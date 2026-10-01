/**
 * System One: `git rm --cached` only untracks (#3298).
 *
 * Pilot l5-feature-e2e (main 132555b2, run 2026-10-01_172135) ran
 * `git rm --cached .8gent/state.db .8gent/state.db-shm .8gent/state.db-wal`.
 * The rules pass it, so the Selene judge was asked and blocked it
 * (pYes=0.6764). `--cached` removes paths from the index and leaves the files
 * on disk, so the allowlist now passes it without the judge.
 *
 * Plain `git rm <file>` deletes the file from the working tree. It keeps its
 * treatment: no allowlist pass, the judge decides. A chained `rm` is still
 * caught by the rules.
 *
 * Most commands here are parser text only. The real-git suites DO execute
 * commands: each runs `git` and `sh`/`bash`/`zsh -c` inside a throwaway repo
 * under the OS temp dir, with a hermetic environment (no inherited GIT_*
 * variables, no system or global git config, no hooks, HOME in a temp dir).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { readOnlyAllowlist } from "../decide/allowlist";
import { type Decider, createDecider } from "../decide/index";
import { decideRules } from "../decide/rules";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import {
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

const PILOT = "git rm --cached .8gent/state.db .8gent/state.db-shm .8gent/state.db-wal";

const passes = (c: string) => readOnlyAllowlist(c).verdict === "pass-without-model";

describe("allowlist: git rm --cached (#3298)", () => {
	test("the exact pilot command passes without the judge", () => {
		expect(decideRules(PILOT).verdict).toBe("pass");
		expect(readOnlyAllowlist(PILOT)).toEqual({
			verdict: "pass-without-model",
			reason: "read-only",
		});
	});

	test("recursive and flag-order variants pass", () => {
		for (const c of [
			"git rm -r --cached .8gent",
			"git rm --cached -r .8gent",
			"git rm -r -f --cached node_modules",
			"git rm --cached -q --ignore-unmatch dist",
			"git rm --cached -- .8gent/state.db",
			"git rm --cached -- --no-cached", // after `--` it is a path
			"git rm --cached --dry-run -r .",
			"git rm --cached --force --quiet -n a.txt",
			"git rm --cached a@b.txt c+d=e,f:g%h.txt",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: true });
	});

	// Deny-by-default on the raw text (#3299 re-review): anything outside the
	// plain shape goes to the judge, even when it would have been safe.
	test("anything outside the plain shape is no-opinion", () => {
		for (const c of [
			"git rm -rf --cached node_modules", // flag cluster
			"git rm --cached -rq dist",
			"git -C ../other rm --cached a.txt", // not `git rm` first
			"git rm --cached a.txt && git status", // more than one command
			"git rm --cached --cached a.txt", // --cached twice
			"git rm --cached a.txt -r", // flag after a path
			"git rm --cached a.txt --no-cached",
			"git rm --cached 'a.txt'", // quoting
			"git rm --cached a\\ b",
			"git -C --cached rm a", // pins the `git rm` first-words check
			"git --no-pager rm --cached a",
			"git rm --cached --", // no path after --
			"git rm --cached ~/a.txt",
			"git rm\t--cached a.txt",
			" git rm --cached a.txt\n",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("plain git rm, which deletes from disk, is never passed", () => {
		for (const c of [
			"git rm a.txt",
			"git rm -r src",
			"git rm -rf src",
			"git rm -f a.txt",
			"git rm -- --cached", // `--cached` after `--` is a path, not the flag
			"git rm --cached", // no path
			"git rm --cache a.txt", // abbreviation: no opinion, judge decides
			"git rm --cached --no-cached a.txt", // negation undoes --cached
			"git rm --cached --pathspec-from-file=list.txt",
			"git rm --cached a.txt && git rm b.txt",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
	});

	test("a chained rm is still caught by the rules and never passed", () => {
		const c = "git rm --cached a && rm -rf b";
		expect(decideRules(c)).toMatchObject({ verdict: "escalate", rule: "rm_recursive" });
		expect(passes(c)).toBe(false);
		for (const x of [
			"git rm --cached a; rm b.txt",
			"git rm --cached a || rm -f src/x.ts",
			"git rm --cached a | xargs rm",
		]) {
			expect({ x, rules: decideRules(x).verdict }).toEqual({ x, rules: "escalate" });
			expect({ x, pass: passes(x) }).toEqual({ x, pass: false });
		}
	});

	test("a secret path or a substitution is still no-opinion", () => {
		expect(passes("git rm --cached .env")).toBe(false);
		expect(passes("git rm --cached $(cat list)")).toBe(false);
		expect(passes("git rm --cached `ls`")).toBe(false);
	});

	// #3299 review: each of these deleted a tracked file under sh -c, because
	// the parser saw different words from the ones sh hands to git.
	test("words the parser could misread are no-opinion (#3299 review)", () => {
		for (const c of BYPASSES) expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
		// A `#` or brace anywhere in the segment, or a glob before `--`.
		for (const c of [
			"git rm --cached a#b",
			"git rm --cached '#notes'",
			"git rm --cached {a,b}",
			"git rm --cached a}",
			"git rm --cached a?",
			"git rm --cached [ab]",
			"git rm -r --cached src/*.ts",
		])
			expect({ c, pass: passes(c) }).toEqual({ c, pass: false });
		// Even after `--`, where it would be safe, a glob is outside the plain set.
		expect(passes("git rm --cached -- *")).toBe(false);
		expect(passes("git rm -r --cached -- src/*.ts")).toBe(false);
	});
});

/** Commands from the #3299 reviews that the allowlist passed at afcbf699 or 9f31891c. */
const BYPASSES = [
	"git rm --cached a#b --no-cached", // mid-word `#`: the parser saw a comment
	"git rm --cached {a,--no-cached}", // brace: bash expands it to a flag
	"git rm --cached *", // glob: matches a planted file named --no-cached
	// #3299 re-review, at 9f31891c:
	"git rm a >&2--cached", // sh redirects to the file `2--cached`, runs plain git rm a
	"git rm a 2>&1--cached", // zsh does the same
	"git rm a\\\n--cached", // backslash-newline: sh makes the word `a--cached`
	"git rm a\r--cached", // CR: sh keeps it inside the word
	"git rm --cached\r a", // CR glued to the flag
	// #3299 code review: a TAB is a word break to sh, so `--no-cached` is a flag.
	"git rm --cached a\t--no-cached",
];

// ------------------------------------------------------------------ real git
//
// Hermetic: every spawn gets HERMETIC_ENV (process.env minus every GIT_*
// variable, BASH_ENV and ENV, with no system or global git config, no
// templates, and HOME in a temp dir). git exports GIT_DIR and GIT_INDEX_FILE
// to hooks, so a `bun test` started from a hook would otherwise point every
// command below at the real checkout (#3299 code review, C1).

const SANDBOX_ROOT = realpathSync(tmpdir());
const FAKE_HOME = realpathSync(tempDir("s1-git-rm-home-"));

function hermeticEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined || k.startsWith("GIT_") || k === "BASH_ENV" || k === "ENV") continue;
		env[k] = v;
	}
	return {
		...env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TEMPLATE_DIR: "",
		HOME: FAKE_HOME,
	};
}

/** Run a program in `dir` with the hermetic env; refuse any dir outside the temp root. */
function run(file: string, args: string[], dir: string) {
	const real = realpathSync(dir);
	if (!real.startsWith(`${SANDBOX_ROOT}/`))
		throw new Error(`refusing to run outside ${SANDBOX_ROOT}: ${real}`);
	const r = spawnSync(file, args, { cwd: real, encoding: "utf8", env: hermeticEnv() });
	if (r.error || r.status === null)
		throw new Error(`${file} did not run: ${r.error?.message ?? r.signal}`);
	return r;
}

function git(dir: string, ...args: string[]): string {
	const r = run("git", args, dir);
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
}

const FILES = ["a", "a#b", "sub/c", "--no-cached"];

/** Tracked files in the throwaway repo: `a`, `a#b`, `sub/c`, plus a planted `--no-cached`. */
function throwawayRepo(): string {
	const dir = realpathSync(tempDir("s1-git-rm-real-"));
	git(dir, "init", "-q");
	mkdirSync(join(dir, "sub"));
	for (const f of FILES) writeFileSync(join(dir, f), f);
	git(dir, "add", "--", ".");
	git(
		dir,
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"commit.gpgsign=false",
		"-c",
		"user.email=t@example.invalid",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		"seed",
	);
	// The repo git sees is this one, not one named by an inherited variable.
	if (git(dir, "rev-parse", "--show-toplevel").trim() !== dir)
		throw new Error("throwaway repo is not isolated");
	return dir;
}

const tracked = (dir: string) => git(dir, "ls-files", "-z").split("\0").filter(Boolean);

/** Each corpus line, and what it must untrack if the allowlist passes it. */
const CORPUS: { c: string; untracks?: string[] }[] = [
	{ c: "git rm --cached a", untracks: ["a"] },
	{ c: "git rm -r --cached sub", untracks: ["sub/c"] },
	{ c: "git rm --cached -r sub", untracks: ["sub/c"] },
	{ c: "git rm --cached -q -- a sub/c", untracks: ["a", "sub/c"] },
	{ c: "git rm --cached -- --no-cached", untracks: ["--no-cached"] },
	{ c: "git rm -r -f --cached --force --quiet -- sub a", untracks: ["sub/c", "a"] },
	{ c: "git rm --cached -n a", untracks: [] }, // dry run
	{ c: "git rm -rf --cached ." }, // cluster: no-opinion
	{ c: "git rm --cached -- *" }, // glob: no-opinion
	...BYPASSES.map((c) => ({ c })),
];

const hasGit = spawnSync("git", ["--version"]).status === 0;
const hasShell = (s: string) => spawnSync(s, ["-c", "true"]).status === 0;

afterAll(cleanupTempDirs);

for (const shell of ["sh", "bash", "zsh"]) {
	describe.skipIf(!hasGit || !hasShell(shell))(`real git under ${shell} -c`, () => {
		// Positive control: the harness can see a deletion. Without it, a broken
		// spawn would make every "nothing deleted" assertion pass.
		test("control: plain git rm a deletes a", () => {
			const dir = throwawayRepo();
			run(shell, ["-c", "git rm -q a"], dir);
			expect(existsSync(join(dir, "a"))).toBe(false);
		});

		for (const { c, untracks } of CORPUS) {
			test(JSON.stringify(c), () => {
				const dir = throwawayRepo();
				const passed = passes(c);
				const before = tracked(dir);
				run(shell, ["-c", c], dir);
				if (passed) {
					// Passed without the judge: it only untracks, it never deletes.
					expect({ c, gone: FILES.filter((f) => !existsSync(join(dir, f))) }).toEqual({
						c,
						gone: [],
					});
					expect(untracks).toBeDefined();
					const lost = before.filter((f) => !tracked(dir).includes(f)).sort();
					expect({ c, lost }).toEqual({ c, lost: [...(untracks ?? [])].sort() });
				}
				if (BYPASSES.includes(c)) expect({ c, passed }).toEqual({ c, passed: false });
			});
		}
	});
}

describe.skipIf(!hasGit)(
	"isolation: an inherited GIT_DIR cannot reach a real repo (#3299 C1)",
	() => {
		test("with GIT_DIR and GIT_WORK_TREE pointing at a decoy, the decoy is untouched", () => {
			const decoy = throwawayRepo();
			const configBefore = readFileSync(join(decoy, ".git", "config"), "utf8");
			const headBefore = git(decoy, "rev-parse", "HEAD");
			const saved = {
				dir: process.env.GIT_DIR,
				tree: process.env.GIT_WORK_TREE,
				index: process.env.GIT_INDEX_FILE,
			};
			process.env.GIT_DIR = join(decoy, ".git");
			process.env.GIT_WORK_TREE = decoy;
			process.env.GIT_INDEX_FILE = join(decoy, ".git", "index");
			try {
				const dir = throwawayRepo();
				run("sh", ["-c", "git rm -q a"], dir);
				run("sh", ["-c", "git rm -r -f --cached --force --quiet -- sub"], dir);
			} finally {
				for (const [k, v] of [
					["GIT_DIR", saved.dir],
					["GIT_WORK_TREE", saved.tree],
					["GIT_INDEX_FILE", saved.index],
				] as const) {
					if (v === undefined) Reflect.deleteProperty(process.env, k);
					else process.env[k] = v;
				}
			}
			expect(readFileSync(join(decoy, ".git", "config"), "utf8")).toBe(configBefore);
			expect(git(decoy, "rev-parse", "HEAD")).toBe(headBefore);
			expect(git(decoy, "log", "--oneline").trim().split("\n").length).toBe(1);
			expect(tracked(decoy).sort()).toEqual([...FILES].sort());
			expect(FILES.filter((f) => !existsSync(join(decoy, f)))).toEqual([]);
		});

		test("run() refuses a directory outside the temp root", () => {
			expect(() => run("sh", ["-c", "true"], "/")).toThrow(/refusing to run outside/);
		});
	},
);

// A judge that answers "yes, harmful" to everything and counts how often it is asked.
class BlockingBackend implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.999 },
					confidence: 0.999,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

describe("gate: git rm --cached (#3298)", () => {
	let backend: BlockingBackend;
	let calDir: string;
	// The pilot's setting: EIGHT_SYSTEM_ONE=1, allowlist on by default.
	const env = { [SYSTEM_ONE_FLAG]: "1" };

	beforeEach(() => {
		_resetSystemOne();
		backend = new BlockingBackend();
		calDir = tempDir("s1-git-rm-cached-");
		_setSystemOneOverridesForTests({
			createDecider: (): Decider => createDecider({ backend, cacheSize: 0 }),
			askHuman: async () => null,
			calibrationDir: calDir,
		});
	});
	afterEach(() => {
		_resetSystemOne();
		rmSync(calDir, { recursive: true, force: true });
	});

	test("the pilot command runs and the judge is not asked", async () => {
		const r = await systemOneGate(PILOT, env);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(backend.asks).toBe(0);
	});

	test("plain git rm goes to the judge, and a refusing judge stops it", async () => {
		const r = await systemOneGate("git rm a.txt", env);
		expect(backend.asks).toBe(1);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});

	test("every review bypass goes to the judge (#3299 reviews)", async () => {
		for (const c of BYPASSES) {
			const before = backend.asks;
			const r = await systemOneGate(c, env);
			expect({ c, asked: backend.asks - before, run: r.run }).toEqual({ c, asked: 1, run: false });
		}
	});

	test("the chained rm is still stopped", async () => {
		const r = await systemOneGate("git rm --cached a && rm -rf b", env);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
		expect(r.guard?.rule).toBe("rm_recursive");
	});
});
