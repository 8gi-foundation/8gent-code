import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CheckoutDeps,
	type ExecFn,
	bunStep,
	defaultExec,
	findBrowserCheckout,
	findCheckoutRoot,
	modulePathToFs,
	originTrusted,
	parseOrigin,
	resolveExecutable,
	runSourceUpdate,
	samePath,
	scrubbedEnv,
	untrackedClashes,
	updateCheckout,
} from "./source-update";

const A = "a".repeat(40);
const B = "b".repeat(40);
const DIR = "/work/8gent-code";

interface Call {
	file: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
}

/** Fake git/bun. `git` handlers match on the git subcommand text (after the -c flags). */
function fake(
	handlers: Record<string, { code?: number; stdout?: string; stderr?: string }>,
	calls: Call[],
): ExecFn {
	return async (file, args, opts) => {
		calls.push({ file, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
		const sub = args.filter((_, i) => !(args[i] === "-c" || args[i - 1] === "-c")).join(" ");
		const key = Object.keys(handlers).find((k) => sub.startsWith(k));
		const h = key ? handlers[key] : undefined;
		return { code: h?.code ?? 0, stdout: h?.stdout ?? "", stderr: h?.stderr ?? "" };
	};
}

const baseHandlers = () => base();
const base = (extra: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) => ({
	"rev-parse --show-toplevel": { stdout: `${DIR}\n` },
	"rev-parse HEAD": { stdout: `${A}\n` },
	"symbolic-ref": { stdout: "main\n" },
	"remote get-url": { stdout: "https://github.com/8gi-foundation/8gent-code.git\n" },
	status: { stdout: "" },
	fetch: {},
	"rev-parse refs/remotes/origin/main": { stdout: `${B}\n` },
	[`merge-base --is-ancestor ${B} ${A}`]: { code: 1 }, // origin is not behind us
	[`merge-base --is-ancestor ${A} ${B}`]: { code: 0 }, // we are behind: fast-forward
	log: { stdout: "bbbbbbb feat: new thing\nccccccc fix: other\n" },
	...extra,
});

const mk = (calls: Call[], handlers = base(), lock = true): CheckoutDeps => ({
	exec: fake(handlers, calls),
	git: "/usr/bin/git",
	bun: "/usr/bin/bun",
	platform: "linux",
	fileExists: (f) => lock && f.endsWith("bun.lock"),
	now: () => new Date("2026-10-12T10:20:30Z"),
});

const opts = {
	dir: DIR,
	force: false,
	checkOnly: false,
	build: false,
	repo: "8gent-code" as const,
	yes: true,
};
const BUN_FLAGS = ["--no-env-file", "--config=/dev/null"];
const subs = (calls: Call[]) =>
	calls.map((c) => c.args.filter((a, i) => a !== "-c" && c.args[i - 1] !== "-c").join(" "));

describe("updateCheckout (injected exec)", () => {
	test("a clean fast-forward updates, installs with the frozen lockfile, and reports old/new and changes", async () => {
		const calls: Call[] = [];
		const r = await updateCheckout(mk(calls), opts);
		expect(r.status).toBe("updated");
		expect(r.from).toBe(A);
		expect(r.to).toBe(B);
		expect(r.changes).toEqual(["bbbbbbb feat: new thing", "ccccccc fix: other"]);
		const s = subs(calls);
		expect(s).toContain("merge --ff-only refs/remotes/origin/main");
		expect(s.some((x) => x.startsWith("reset"))).toBe(false);
		const install = calls.find((c) => c.file === "/usr/bin/bun");
		expect(install?.args).toEqual([...BUN_FLAGS, "install", "--frozen-lockfile"]);
		expect(install?.cwd).toBe(DIR);
	});

	test("no lockfile means a plain bun install", async () => {
		const calls: Call[] = [];
		await updateCheckout(mk(calls, base(), false), opts);
		expect(calls.find((c) => c.file === "/usr/bin/bun")?.args).toEqual([...BUN_FLAGS, "install"]);
	});

	test("a dirty tree is refused before any fetch, merge or reset", async () => {
		const calls: Call[] = [];
		const r = await updateCheckout(
			mk(calls, base({ status: { stdout: " M packages/eight/agent.ts\n" } })),
			opts,
		);
		expect(r.status).toBe("refused");
		expect(r.message).toContain("packages/eight/agent.ts");
		expect(r.message).toContain("--force");
		const s = subs(calls);
		expect(
			s.some((x) => x.startsWith("fetch") || x.startsWith("merge ") || x.startsWith("reset")),
		).toBe(false);
		expect(calls.some((c) => c.file === "/usr/bin/bun")).toBe(false);
	});

	test("--force on a dirty tree makes a backup branch from a stash commit, then resets", async () => {
		const calls: Call[] = [];
		const snap = "c".repeat(40);
		const r = await updateCheckout(
			mk(calls, base({ status: { stdout: " M a.ts\n" }, "stash create": { stdout: `${snap}\n` } })),
			{ ...opts, force: true },
		);
		expect(r.status).toBe("updated");
		expect(r.backupBranch).toBe("backup/8gent-update-20261012-102030-aaaaaaa");
		const s = subs(calls);
		const iBranch = s.indexOf(`branch backup/8gent-update-20261012-102030-aaaaaaa ${snap}`);
		const iReset = s.indexOf(`reset --hard ${B}`);
		expect(iBranch).toBeGreaterThan(-1);
		expect(iReset).toBeGreaterThan(iBranch); // backup first
		expect(s.some((x) => x.startsWith("stash push") || x === "stash")).toBe(false); // never the stash list
	});

	test("a diverged history is refused with a clear message and nothing moves", async () => {
		const calls: Call[] = [];
		const h = base({ ["merge-base --is-ancestor " + A + " " + B]: { code: 1 } });
		const r = await updateCheckout(mk(calls, h), opts);
		expect(r.status).toBe("refused");
		expect(r.message).toContain("diverged");
		expect(r.message).toContain("--force");
		const s = subs(calls);
		expect(s.some((x) => x.startsWith("merge ") || x.startsWith("reset"))).toBe(false);
	});

	test("diverged with --force keeps the local commits on a backup branch", async () => {
		const calls: Call[] = [];
		const h = base({ ["merge-base --is-ancestor " + A + " " + B]: { code: 1 } });
		const r = await updateCheckout(mk(calls, h), { ...opts, force: true });
		expect(r.status).toBe("updated");
		expect(r.backupBranch).toStartWith("backup/8gent-update-");
	});

	test("already up to date, and local ahead of origin, change nothing", async () => {
		const calls: Call[] = [];
		const same = await updateCheckout(
			mk(calls, base({ "rev-parse refs/remotes/origin/main": { stdout: `${A}\n` } })),
			opts,
		);
		expect(same.status).toBe("current");
		const c2: Call[] = [];
		const ahead = await updateCheckout(
			mk(c2, base({ ["merge-base --is-ancestor " + B + " " + A]: { code: 0 } })),
			opts,
		);
		expect(ahead.status).toBe("ahead-local");
		expect(subs(c2).some((x) => x.startsWith("merge ") || x.startsWith("reset"))).toBe(false);
	});

	test("not on main, or no origin, is refused or failed without touching anything", async () => {
		const c1: Call[] = [];
		const feat = await updateCheckout(
			mk(c1, base({ "symbolic-ref": { stdout: "feat/x\n" } })),
			opts,
		);
		expect(feat.status).toBe("refused");
		expect(feat.message).toContain("feat/x");
		const c2: Call[] = [];
		const none = await updateCheckout(mk(c2, base({ "remote get-url": { code: 2 } })), opts);
		expect(none.status).toBe("failed");
		expect(none.message).toContain("no 'origin'");
		for (const c of [c1, c2]) expect(subs(c).some((x) => x.startsWith("fetch"))).toBe(false);
	});

	test("a directory inside another work tree is not touched", async () => {
		const calls: Call[] = [];
		const r = await updateCheckout(
			mk(
				calls,
				base({
					"rev-parse --show-toplevel": { stdout: "/work\n" },
					"rev-parse --show-cdup": { stdout: "../8gent-code\n" },
				}),
			),
			opts,
		);
		expect(r.status).toBe("failed");
		expect(r.message).toContain("another git work tree");
		// toplevel, then git's own answer on whether the directory is the top; nothing after.
		expect(calls.length).toBe(2);
	});

	test("--check reports how far ahead origin is and changes nothing", async () => {
		const calls: Call[] = [];
		const r = await updateCheckout(mk(calls, base({ "rev-list --count": { stdout: "3\n" } })), {
			...opts,
			checkOnly: true,
		});
		expect(r.status).toBe("available");
		expect(r.message).toContain("3 commits ahead");
		expect(r.canFastForward).toBe(true);
		expect(
			subs(calls).some(
				(x) => x.startsWith("merge ") || x.startsWith("reset") || x.startsWith("branch"),
			),
		).toBe(false);
		expect(calls.some((c) => c.file === "/usr/bin/bun")).toBe(false);
	});

	test("a failed bun install is reported with the output tail, after the code already moved", async () => {
		const calls: Call[] = [];
		const d = mk(calls);
		const inner = d.exec;
		d.exec = async (f, a, o) =>
			f === "/usr/bin/bun"
				? { code: 1, stdout: "", stderr: "lockfile had changes" }
				: inner(f, a, o);
		const r = await updateCheckout(d, opts);
		expect(r.status).toBe("failed");
		expect(r.message).toContain("bun install failed");
		expect(r.message).toContain("lockfile had changes");
	});

	test("every call is a fixed argv array with a timeout, and no remote is added or changed", async () => {
		const calls: Call[] = [];
		await updateCheckout(mk(calls), { ...opts, build: true });
		for (const c of calls) {
			expect(Array.isArray(c.args)).toBe(true);
			expect(c.timeoutMs).toBeGreaterThan(0);
			expect(c.cwd).toBe(DIR);
		}
		const s = subs(calls).join("\n");
		expect(s).not.toMatch(/remote (add|set-url|remove|rename)/);
		expect(s).not.toContain("pull");
		expect(calls.filter((c) => c.file === "/usr/bin/bun").map((c) => c.args.join(" "))).toEqual([
			`${BUN_FLAGS.join(" ")} install --frozen-lockfile`,
			`${BUN_FLAGS.join(" ")} run build`,
		]);
		expect(calls.find((c) => c.args.includes("fetch"))?.args.slice(-2)).toEqual([
			"origin",
			"+refs/heads/main:refs/remotes/origin/main",
		]);
	});
});

describe("runSourceUpdate and the 8gent Browser checkout", () => {
	const mkRun = (
		browserDir: string | null,
		log: string[],
		calls: Call[],
		origin = "git@github.com:8gi-foundation/8gent-browser.git",
	) => {
		const inner = fake(base(), calls);
		return {
			modulePath: `file://${DIR}/bin/8gent.ts`,
			env: { PATH: "/usr/bin", EIGHT_BROWSER_SRC: browserDir ?? undefined },
			platform: "linux",
			home: "/home/u",
			log: (l: string) => log.push(l),
			isFile: () => true,
			hasGit: (d: string) => d === DIR || d === browserDir,
			fileExists: () => true,
			now: () => new Date("2026-10-12T10:20:30Z"),
			exec: ((f, a, o) =>
				inner(f, a, o).then((r) =>
					// the browser checkout reports its own toplevel
					a.includes("--show-toplevel") && o.cwd === browserDir
						? { ...r, stdout: `${browserDir}\n` }
						: a.includes("get-url") && o.cwd === browserDir
							? { ...r, stdout: `${origin}\n` }
							: r,
				)) as ExecFn,
		};
	};

	test("browser found: updated, installed frozen, built; reported as old -> new", async () => {
		const log: string[] = [];
		const calls: Call[] = [];
		const code = await runSourceUpdate(mkRun("/work/8gent-browser", log, calls), {
			force: false,
			checkOnly: false,
			yes: true,
		});
		expect(code).toBe(0);
		expect(log.some((l) => l.startsWith("8gent updated aaaaaaa -> bbbbbbb"))).toBe(true);
		expect(
			log.some((l) => l.includes("8gent Browser (/work/8gent-browser) updated aaaaaaa -> bbbbbbb")),
		).toBe(true);
		const browserBun = calls
			.filter((c) => c.file === "/usr/bin/bun" && c.cwd === "/work/8gent-browser")
			.map((c) => c.args.join(" "));
		expect(browserBun).toEqual([
			`${BUN_FLAGS.join(" ")} install --frozen-lockfile`,
			`${BUN_FLAGS.join(" ")} run build`,
		]);
	});

	test("browser not found: says where it looked and still succeeds", async () => {
		const log: string[] = [];
		const code = await runSourceUpdate(mkRun(null, log, []), {
			force: false,
			checkOnly: false,
			yes: true,
		});
		expect(code).toBe(0);
		expect(log.join("\n")).toContain("no source checkout found (looked in /home/u/8gent-browser)");
	});

	test("a browser build failure is reported exactly and fails the command", async () => {
		const log: string[] = [];
		const calls: Call[] = [];
		const deps = mkRun("/work/8gent-browser", log, calls);
		const inner = deps.exec;
		deps.exec = async (f, a, o) =>
			a.includes("build") ? { code: 2, stdout: "", stderr: "tsc: error TS2304" } : inner(f, a, o);
		expect(await runSourceUpdate(deps, { force: false, checkOnly: false, yes: true })).toBe(1);
		expect(log.join("\n")).toContain("bun run build failed");
		expect(log.join("\n")).toContain("tsc: error TS2304");
	});

	test("EIGHT_BROWSER_SRC must be absolute; the code checkout is never taken as the browser", () => {
		const hasGit = () => true;
		const rel = findBrowserCheckout({
			env: { EIGHT_BROWSER_SRC: "rel/dir" },
			home: "/h",
			platform: "linux",
			codeRoot: "/h/code",
			hasGit,
		});
		expect(rel.note).toContain("not an absolute path");
		expect(rel.dir).toBe("/h/8gent-browser");
		const same = findBrowserCheckout({
			env: { EIGHT_BROWSER_SRC: "/h/8gent-browser" },
			home: "/h",
			platform: "linux",
			codeRoot: "/h/8gent-browser",
			hasGit,
		});
		expect(same.dir).toBeNull();
	});

	test("git or bun missing from an absolute PATH entry is a clear failure", async () => {
		const log: string[] = [];
		const deps = { ...mkRun(null, log, []), isFile: () => false };
		expect(await runSourceUpdate(deps, { force: false, checkOnly: false, yes: true })).toBe(1);
		expect(log[0]).toContain("git was not found");
	});
});

describe("Windows", () => {
	const winFiles = new Set([
		"C:\\Program Files\\Git\\cmd\\git.exe",
		"C:\\Users\\Artale\\.bun\\bin\\bun.exe",
	]);
	const isFile = (p: string) => winFiles.has(p);

	test("resolveExecutable reads Path case-insensitively, skips relative entries, finds .exe", () => {
		const env = {
			Path: ".;tools;C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Users\\Artale\\.bun\\bin",
		};
		expect(resolveExecutable("git", { env, platform: "win32", isFile })).toBe(
			"C:\\Program Files\\Git\\cmd\\git.exe",
		);
		expect(resolveExecutable("bun", { env, platform: "win32", isFile })).toBe(
			"C:\\Users\\Artale\\.bun\\bin\\bun.exe",
		);
	});

	test("a git.exe in a relative PATH entry or the cwd is never chosen", () => {
		const env = { PATH: ".;bin;" };
		expect(resolveExecutable("git", { env, platform: "win32", isFile: () => true })).toBeNull();
		expect(
			resolveExecutable("git", {
				env: { PATH: "rel:/abs" },
				platform: "linux",
				isFile: (p) => p === "/abs/git",
			}),
		).toBe("/abs/git");
		expect(
			resolveExecutable("git", { env: { PATH: "rel" }, platform: "linux", isFile: () => true }),
		).toBeNull();
	});

	test("backslash, forward-slash and case differences are the same directory on Windows", () => {
		expect(samePath("C:/Users/Artale/8gent-code", "c:\\users\\artale\\8gent-code\\", "win32")).toBe(
			true,
		);
		expect(samePath("/a/B", "/a/b", "linux")).toBe(false);
	});

	test("file:///C:/ module URLs resolve to a checkout root", () => {
		expect(modulePathToFs("file:///C:/Users/Artale/8gent-code/bin/8gent.ts")).toBe(
			"C:/Users/Artale/8gent-code/bin/8gent.ts",
		);
		const root = findCheckoutRoot(
			"file:///C:/Users/Artale/8gent-code/bin/8gent.ts",
			"win32",
			(d) => d.toLowerCase() === "c:\\users\\artale\\8gent-code",
		);
		expect(root?.toLowerCase()).toBe("c:\\users\\artale\\8gent-code");
	});

	test("the browser checkout is found under a Windows home with backslashes", () => {
		const r = findBrowserCheckout({
			env: {},
			home: "C:\\Users\\Artale",
			platform: "win32",
			codeRoot: "C:\\Users\\Artale\\8gent-code",
			hasGit: (d) => d === "C:\\Users\\Artale\\8gent-browser",
		});
		expect(r.dir).toBe("C:\\Users\\Artale\\8gent-browser");
	});

	test("no POSIX-only env is set by the default exec", () => {
		const src = defaultExec.toString();
		expect(src).not.toMatch(/LANG=|LC_ALL|SHELL/);
	});
});

// ── integration: real git, local bare repos ──────────────────────────

describe("integration with a file:// origin", () => {
	const root = mkdtempSync(join(tmpdir(), "src-update-it-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const git = (cwd: string, ...a: string[]) =>
		execFileSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a],
			{ cwd, encoding: "utf8" },
		).trim();
	// The absolute git the way the updater finds it. `which` would answer a POSIX
	// path on Windows (Git Bash's /usr/bin/git), which spawn() cannot run.
	const gitPath =
		resolveExecutable("git", { env: process.env, platform: process.platform }) ?? "git";
	const fopts = (dir: string) => ({
		dir,
		force: false,
		checkOnly: false,
		build: false,
		repo: "8gent-code" as const,
		yes: true,
	});

	const realDeps = (bunCalls: string[][]): CheckoutDeps => ({
		exec: (f, a, o) => {
			if (f !== "bun") return defaultExec(f, a, o);
			bunCalls.push(a);
			return Promise.resolve({ code: 0, stdout: "", stderr: "" });
		},
		git: gitPath,
		bun: "bun",
		platform: process.platform,
		fileExists: () => false,
		now: () => new Date("2026-10-12T10:20:30Z"),
		// file:// is not an allowlisted origin, so these tests exercise the confirm path.
		confirm: async () => true,
	});

	function setup(name: string, shallow: boolean) {
		const bare = join(root, `${name}.git`);
		const seed = join(root, `${name}-seed`);
		const clone = join(root, `${name}-clone`);
		mkdirSync(seed);
		git(root, "init", "--bare", "-b", "main", bare);
		git(seed, "init", "-b", "main");
		writeFileSync(join(seed, "a.txt"), "1\n");
		git(seed, "add", ".");
		git(seed, "commit", "-m", "first");
		git(seed, "remote", "add", "origin", `file://${bare}`);
		git(seed, "push", "origin", "main");
		git(root, "clone", ...(shallow ? ["--depth", "1"] : []), `file://${bare}`, clone);
		writeFileSync(join(seed, "a.txt"), "2\n");
		git(seed, "commit", "-am", "second: feat(update)");
		git(seed, "push", "origin", "main");
		return { bare, seed, clone };
	}

	for (const shallow of [false, true]) {
		test(`a real fast-forward update (${shallow ? "shallow" : "full"} clone)`, async () => {
			const { clone, seed } = setup(shallow ? "s" : "f", shallow);
			const before = git(clone, "rev-parse", "HEAD");
			const bunCalls: string[][] = [];
			const r = await updateCheckout(realDeps(bunCalls), fopts(clone));
			expect(r.status, r.message).toBe("updated");
			expect(r.from).toBe(before);
			expect(r.to).toBe(git(seed, "rev-parse", "HEAD"));
			expect(git(clone, "rev-parse", "HEAD")).toBe(r.to as string);
			expect(r.changes?.[0]).toContain("second: feat(update)");
			expect(bunCalls).toEqual([
				[
					"--no-env-file",
					`--config=${process.platform === "win32" ? bunCalls[0][1].slice(9) : "/dev/null"}`,
					"install",
				],
			]);
			expect(git(clone, "remote")).toBe("origin");
			// a second run is a no-op
			expect((await updateCheckout(realDeps([]), fopts(clone))).status).toBe("current");
		});
	}

	test("real dirty tree is refused and the file keeps its edit; --force backs it up", async () => {
		const { clone } = setup("d", false);
		writeFileSync(join(clone, "a.txt"), "my edit\n");
		const refused = await updateCheckout(realDeps([]), fopts(clone));
		expect(refused.status, refused.message).toBe("refused");
		expect(git(clone, "show", "HEAD:a.txt")).toBe("1");
		const forced = await updateCheckout(realDeps([]), { ...fopts(clone), force: true });
		expect(forced.status).toBe("updated");
		expect(git(clone, "show", `${forced.backupBranch}:a.txt`)).toBe("my edit");
		expect(git(clone, "show", "HEAD:a.txt")).toBe("2");
		expect(git(clone, "stash", "list")).toBe("");
	});

	test("--force keeps untracked files that do not clash, and backs up the tracked edit", async () => {
		const { clone } = setup("u", false);
		writeFileSync(join(clone, "a.txt"), "my edit\n");
		writeFileSync(join(clone, "mine.txt"), "untracked work\n");
		const r = await updateCheckout(realDeps([]), { ...fopts(clone), force: true });
		expect(r.status, r.message).toBe("updated");
		expect(readFileSync(join(clone, "mine.txt"), "utf8")).toBe("untracked work\n");
		expect(git(clone, "show", `${r.backupBranch}:a.txt`)).toBe("my edit");
	});

	test("--force refuses when an untracked file would be overwritten, and nothing changes", async () => {
		const { clone, seed, bare } = setup("c", false);
		writeFileSync(join(seed, "extra.txt"), "from origin\n");
		git(seed, "add", ".");
		git(seed, "commit", "-m", "adds extra");
		git(seed, "push", "origin", "main");
		writeFileSync(join(clone, "a.txt"), "my edit\n");
		writeFileSync(join(clone, "extra.txt"), "my precious untracked\n");
		const head = git(clone, "rev-parse", "HEAD");
		const r = await updateCheckout(realDeps([]), { ...fopts(clone), force: true });
		expect(r.status, r.message).toBe("refused");
		expect(r.message).toContain("extra.txt");
		expect(readFileSync(join(clone, "extra.txt"), "utf8")).toBe("my precious untracked\n");
		expect(readFileSync(join(clone, "a.txt"), "utf8")).toBe("my edit\n");
		expect(git(clone, "rev-parse", "HEAD")).toBe(head);
		expect(git(clone, "branch", "--list", "backup/*")).toBe("");
		void bare;
	});

	test("--force with an unfinished merge (unmerged paths) aborts with the conflict intact", async () => {
		const { clone } = setup("m", false);
		git(clone, "checkout", "-b", "side");
		writeFileSync(join(clone, "a.txt"), "side\n");
		git(clone, "commit", "-am", "side change");
		git(clone, "checkout", "main");
		writeFileSync(join(clone, "a.txt"), "main\n");
		git(clone, "commit", "-am", "main change");
		try {
			git(clone, "merge", "side");
		} catch {}
		const before = readFileSync(join(clone, "a.txt"), "utf8");
		expect(before).toContain("<<<<<<<");
		const r = await updateCheckout(realDeps([]), { ...fopts(clone), force: true });
		expect(r.status, r.message).toBe("refused");
		expect(r.message).toContain("unmerged");
		expect(readFileSync(join(clone, "a.txt"), "utf8")).toBe(before);
		expect(git(clone, "branch", "--list", "backup/*")).toBe("");
	});

	test("a foreign origin that is declined is never applied", async () => {
		const { clone } = setup("n", false);
		const head = git(clone, "rev-parse", "HEAD");
		const d = realDeps([]);
		d.confirm = async () => false;
		const r = await updateCheckout(d, fopts(clone));
		expect(r.status, r.message).toBe("declined");
		expect(git(clone, "rev-parse", "HEAD")).toBe(head);
	});

	test("real diverged history is refused", async () => {
		const { clone } = setup("v", false);
		writeFileSync(join(clone, "b.txt"), "local\n");
		git(clone, "add", ".");
		git(clone, "commit", "-m", "local only");
		const head = git(clone, "rev-parse", "HEAD");
		const r = await updateCheckout(realDeps([]), fopts(clone));
		expect(r.status, r.message).toBe("refused");
		expect(r.message).toContain("diverged");
		expect(git(clone, "rev-parse", "HEAD")).toBe(head);
	});
});

describe("origin allowlist", () => {
	test("parseOrigin handles https, ssh:// and scp-like urls; junk and file:// are null", () => {
		expect(parseOrigin("https://github.com/8gi-foundation/8gent-browser.git")).toMatchObject({
			host: "github.com",
			repoPath: "8gi-foundation/8gent-browser",
		});
		expect(parseOrigin("git@github.com:8gi-foundation/8gent-browser.git")).toMatchObject({
			host: "github.com",
			scheme: "ssh",
		});
		expect(parseOrigin("ssh://git@forge.example:2222/o/8gent-browser")).toMatchObject({
			host: "forge.example:2222",
			repoPath: "o/8gent-browser",
		});
		expect(parseOrigin("file:///tmp/x.git")).toBeNull();
		expect(parseOrigin("ext::sh -c evil")).toBeNull();
	});

	test("GitHub: only 8gi-foundation/<repo> over https or ssh", () => {
		for (const u of [
			"https://github.com/8gi-foundation/8gent-browser.git",
			"git@github.com:8gi-foundation/8gent-browser.git",
			"ssh://git@github.com/8gi-foundation/8gent-browser",
		])
			expect(originTrusted(u, "8gent-browser")).toBe(true);
		for (const u of [
			"https://github.com/evil/8gent-browser.git",
			"https://github.com.evil.example/8gi-foundation/8gent-browser.git",
			"http://github.com/8gi-foundation/8gent-browser.git",
			"https://github.com/8gi-foundation/8gent-code.git",
			"https://evil.example/8gi-foundation/8gent-browser.git",
		])
			expect(originTrusted(u, "8gent-browser")).toBe(false);
	});

	test("forge: only the pinned owner's repo, over https or ssh, on the host named by EIGHT_FORGE_HOST", () => {
		const u = "https://forge.test:3000/8gi-foundation/8gent-browser.git";
		expect(originTrusted(u, "8gent-browser")).toBe(false); // no host configured, no guess
		expect(originTrusted(u, "8gent-browser", "forge.test:3000")).toBe(true);
		expect(
			originTrusted(
				"ssh://git@forge.test:3000/8gi-foundation/8gent-browser",
				"8gent-browser",
				"forge.test:3000",
			),
		).toBe(true);
		expect(originTrusted(u, "8gent-code", "forge.test:3000")).toBe(false);
		expect(
			originTrusted(
				"https://other.test:3000/8gi-foundation/8gent-browser.git",
				"8gent-browser",
				"forge.test:3000",
			),
		).toBe(false);
		// EIGHT_FORGE_OWNER pins a different owner, exact match
		expect(
			originTrusted(
				"https://forge.test:3000/artale/8gent-browser.git",
				"8gent-browser",
				"forge.test:3000",
				"artale",
			),
		).toBe(true);
		expect(originTrusted(u, "8gent-browser", "forge.test:3000", "artale")).toBe(false);
	});

	test("a foreign owner on the forge host, and a plain http forge origin, fall to the y/N prompt", async () => {
		for (const url of [
			"https://forge.test:3000/someone-else/8gent-browser.git",
			"http://forge.test:3000/8gi-foundation/8gent-browser.git",
		]) {
			expect(originTrusted(url, "8gent-browser", "forge.test:3000")).toBe(false);
			const asked: boolean[] = [];
			const d = mk([], base({ "remote get-url": { stdout: `${url}\n` } }));
			d.forgeHost = "forge.test:3000";
			d.confirm = async (_q, o) => {
				asked.push(o.strict);
				return false;
			};
			const r = await updateCheckout(d, { ...opts, repo: "8gent-browser", yes: true });
			expect(r.status).toBe("declined");
			expect(asked).toEqual([true]);
		}
	});

	test("a planted ~/8gent-browser with a foreign origin is declined by default and never installed or built", async () => {
		const log: string[] = [];
		const calls: Call[] = [];
		const deps = (() => {
			const base = (() => {
				const inner = fake({ ...baseHandlers() }, calls);
				return inner;
			})();
			return {
				modulePath: `file://${DIR}/bin/8gent.ts`,
				env: { PATH: "/usr/bin", EIGHT_BROWSER_SRC: "/home/u/8gent-browser" },
				platform: "linux",
				home: "/home/u",
				log: (l: string) => log.push(l),
				isFile: () => true,
				hasGit: (d: string) => d === DIR || d === "/home/u/8gent-browser",
				fileExists: () => true,
				exec: ((f, a, o) =>
					base(f, a, o).then((r) =>
						a.includes("--show-toplevel") && o.cwd === "/home/u/8gent-browser"
							? { ...r, stdout: "/home/u/8gent-browser\n" }
							: a.includes("get-url") && o.cwd === "/home/u/8gent-browser"
								? { ...r, stdout: "https://evil.example/x/8gent-browser.git\n" }
								: r,
					)) as ExecFn,
			};
		})();
		// no confirm injected and no terminal: the default answer is no, even with --yes
		const code = await runSourceUpdate(deps, { force: false, checkOnly: false, yes: true });
		expect(code).toBe(1);
		const browserCalls = calls.filter((c) => c.cwd === "/home/u/8gent-browser");
		expect(browserCalls.some((c) => c.file === "/usr/bin/bun")).toBe(false);
		expect(browserCalls.some((c) => c.args.includes("merge") || c.args.includes("reset"))).toBe(
			false,
		);
		expect(log.join("\n")).toContain("not confirmed");
	});

	test("a foreign origin asks with the origin and the incoming commits; --yes does not skip it; answering yes proceeds", async () => {
		const asked: { q: string; strict: boolean }[] = [];
		const calls: Call[] = [];
		const d = mk(
			calls,
			base({ "remote get-url": { stdout: "https://evil.example/o/8gent-browser.git\n" } }),
		);
		d.confirm = async (q, o) => (asked.push({ q, strict: o.strict }), true);
		const r = await updateCheckout(d, { ...opts, repo: "8gent-browser", build: true, yes: true });
		expect(r.status).toBe("updated");
		expect(asked).toHaveLength(1);
		expect(asked[0].strict).toBe(true);
		expect(asked[0].q).toContain("https://evil.example/o/8gent-browser.git");
		expect(asked[0].q).toContain("bbbbbbb feat: new thing");
		expect(asked[0].q).toContain("WARNING");
	});

	test("a known origin with --yes does not ask; without --yes it asks (non-strict) and N stops everything", async () => {
		const c1: Call[] = [];
		const d1 = mk(c1);
		let asked = 0;
		d1.confirm = async () => (asked++, true);
		await updateCheckout(d1, opts);
		expect(asked).toBe(0);

		const c2: Call[] = [];
		const d2 = mk(c2);
		const strictSeen: boolean[] = [];
		d2.confirm = async (_q, o) => (strictSeen.push(o.strict), false);
		const r = await updateCheckout(d2, { ...opts, yes: false });
		expect(r.status).toBe("declined");
		expect(strictSeen).toEqual([false]);
		expect(
			subs(c2).some(
				(x) => x.startsWith("merge ") || x.startsWith("reset") || x.startsWith("branch"),
			),
		).toBe(false);
		expect(c2.some((c) => c.file === "/usr/bin/bun")).toBe(false);
	});
});

describe("--force never loses data", () => {
	test("unmerged paths abort: no snapshot, no branch, no reset", async () => {
		const calls: Call[] = [];
		const r = await updateCheckout(
			mk(
				calls,
				base({
					status: { stdout: "UU a.ts\n" },
					"ls-files --unmerged": { stdout: "100644 abc 1\ta.ts\n" },
				}),
			),
			{ ...opts, force: true },
		);
		expect(r.status).toBe("refused");
		expect(r.message).toContain("unmerged");
		expect(
			subs(calls).some(
				(x) =>
					x.startsWith("reset") ||
					x.startsWith("branch") ||
					x.startsWith("stash") ||
					x.startsWith("fetch"),
			),
		).toBe(false);
	});

	test("an empty stash snapshot of a dirty tree aborts before any reset", async () => {
		const calls: Call[] = [];
		const r = await updateCheckout(
			mk(calls, base({ status: { stdout: " M a.ts\n" }, "stash create": { stdout: "\n" } })),
			{ ...opts, force: true },
		);
		expect(r.status).toBe("failed");
		expect(r.message).toContain("could not snapshot");
		expect(subs(calls).some((x) => x.startsWith("reset") || x.startsWith("branch"))).toBe(false);
	});

	test("untracked files that origin/main also has are refused, not overwritten", async () => {
		const calls: Call[] = [];
		const r = await updateCheckout(
			mk(
				calls,
				base({
					status: { stdout: " M a.ts\n" },
					"ls-files --others": { stdout: "docs/new.md\nnotes.txt\n" },
					"ls-tree": { stdout: "a.ts\ndocs/new.md\n" },
				}),
			),
			{ ...opts, force: true },
		);
		expect(r.status).toBe("refused");
		expect(r.message).toContain("docs/new.md");
		expect(subs(calls).some((x) => x.startsWith("reset") || x.startsWith("branch"))).toBe(false);
	});

	test("untrackedClashes sees file/dir collisions both ways", () => {
		expect(untrackedClashes("a/b\nz\n", "a\nq/r\n")).toEqual(["a/b"]);
		expect(untrackedClashes("q\n", "q/r\n")).toEqual(["q"]);
		expect(untrackedClashes("free.txt\n", "q/r\n")).toEqual([]);
	});
});

describe("scrubbed install and build env", () => {
	test("scrubbedEnv keeps PATH/HOME/TMPDIR/LANG-class names and drops keys and tokens (Windows names are case-insensitive)", () => {
		const e = scrubbedEnv({
			PATH: "/bin",
			Path: "C:\\x",
			HOME: "/h",
			TMPDIR: "/t",
			LANG: "en",
			FAKE_API_KEY: "sk-1",
			GITHUB_TOKEN: "t",
			AWS_SECRET_ACCESS_KEY: "s",
			SystemRoot: "C:\\Windows",
		});
		expect(Object.keys(e).sort()).toEqual(["HOME", "LANG", "PATH", "Path", "SystemRoot", "TMPDIR"]);
	});

	test("install and build get the scrubbed env and --no-env-file --config, never the ambient one", async () => {
		const calls: (Call & { env?: Record<string, string> })[] = [];
		const d = mk([]);
		const inner = d.exec;
		d.exec = (f, a, o) => {
			calls.push({ file: f, args: a, cwd: o.cwd, timeoutMs: o.timeoutMs, env: o.env });
			return inner(f, a, o);
		};
		d.baseEnv = { PATH: "/usr/bin", HOME: "/h", FAKE_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "k" };
		await updateCheckout(d, { ...opts, build: true });
		const bunCalls = calls.filter((c) => c.file === "/usr/bin/bun");
		expect(bunCalls).toHaveLength(2);
		for (const c of bunCalls) {
			expect(c.args.slice(0, 2)).toEqual(BUN_FLAGS);
			expect(c.env).toEqual({ PATH: "/usr/bin", HOME: "/h" });
		}
	});

	test("a real postinstall script cannot see FAKE_API_KEY", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scrub-"));
		try {
			const out = join(dir, "env.json");
			writeFileSync(
				join(dir, "write-env.js"),
				`require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`,
			);
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({
					name: "t",
					version: "1.0.0",
					scripts: { postinstall: "bun write-env.js" },
				}),
			);
			// The bun running this test: an absolute native path on every OS (`which`
			// answers a POSIX path on Windows, which spawn() cannot run).
			const bun = process.execPath;
			process.env.FAKE_API_KEY = "sk-must-not-leak";
			const r = await bunStep(
				{
					exec: defaultExec,
					git: "git",
					bun,
					platform: process.platform,
					fileExists: () => false,
					now: () => new Date(),
				},
				dir,
				["install"],
			);
			expect(r.code).toBe(0);
			const seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
			expect(seen.FAKE_API_KEY).toBeUndefined();
			expect(seen.PATH).toBeTruthy();
		} finally {
			process.env.FAKE_API_KEY = undefined;
			delete process.env.FAKE_API_KEY;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
