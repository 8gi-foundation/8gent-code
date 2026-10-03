/**
 * #3402: the agent committed after its own `bun test` returned exit 1 (pilot run
 * 2026-10-03_180159, l5-feature-e2e). git_commit and `git commit` through run_command
 * now run the repo's test script first and refuse a red suite. Driven through the real
 * ToolExecutor in throwaway git repos.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatCommandOutput } from "./command-output";
import { CommitGate, isGitCommit, parseGitCommit } from "./commit-gate";
import { isErrorToolResult } from "./honesty";
import { ToolExecutor } from "./tools";

const PASS = 'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n';
// The pilot's shape: Bun's `$` used without importing it.
const FAIL =
	'import { expect, test } from "bun:test";\ntest("cli prints", async () => {\n\tconst out = await $`echo hi`.text();\n\texpect(out).toBe("hi\\n");\n});\n';
// Counts suite runs in .git/, which git status never sees, so counting does not change the tree.
const COUNT =
	'import { appendFileSync } from "node:fs";\nappendFileSync(".git/gate-runs", "x");\nconst r = Bun.spawnSync([process.execPath, "test"], { stdout: "inherit", stderr: "inherit" });\nprocess.exit(r.exitCode ?? 1);\n';

let dir: string;
let ex: ToolExecutor;
const saved = {
	gate: process.env.EIGHT_COMMIT_GATE,
	t: process.env.EIGHT_COMMIT_GATE_TIMEOUT_SEC,
	path: process.env.PATH,
};
// The bun running these tests, first on PATH, so the suite runs the same whatever the shell's PATH is.
const BUN_FIRST_PATH = `${dirname(process.execPath)}:${saved.path ?? "/usr/bin:/bin"}`;
// A PATH with no bun, yarn or pnpm on it.
const NO_RUNNER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function git(...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	return r.stdout.toString().trim();
}
const commits = () => Number(git("rev-list", "--count", "HEAD"));
const runs = () =>
	existsSync(join(dir, ".git/gate-runs"))
		? readFileSync(join(dir, ".git/gate-runs"), "utf-8").length
		: 0;
const write = (rel: string, content: string) => {
	mkdirSync(join(dir, rel, ".."), { recursive: true });
	writeFileSync(join(dir, rel), content);
};

function repo(pkg: Record<string, unknown> | null) {
	dir = mkdtempSync(join(tmpdir(), "commit-gate-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	if (pkg) write("package.json", JSON.stringify(pkg));
	write("count.ts", COUNT);
	write("test/base.test.ts", PASS);
	git("add", ".");
	git("commit", "-q", "-m", "fixture");
	freshExecutor();
}

/** A new executor: a new session, with no remembered gate result. */
function freshExecutor() {
	ex = new ToolExecutor(dir, "commit-gate-test");
	const pm = (ex as unknown as { permissionManager: { checkPermission: () => string } })
		.permissionManager;
	pm.checkPermission = () => "allowed";
}

const BUN_PKG = { name: "t", private: true, scripts: { test: "bun ./count.ts" } };

beforeEach(() => {
	delete process.env.EIGHT_COMMIT_GATE;
	delete process.env.EIGHT_COMMIT_GATE_TIMEOUT_SEC;
	process.env.PATH = BUN_FIRST_PATH;
});
afterEach(() => {
	for (const [k, v] of [
		["EIGHT_COMMIT_GATE", saved.gate],
		["EIGHT_COMMIT_GATE_TIMEOUT_SEC", saved.t],
		["PATH", saved.path],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("the agent runs the suite before it commits (#3402)", () => {
	test("a failing new test blocks git_commit and returns the failure", async () => {
		repo(BUN_PKG);
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "feat: done" });
		expect(out).toStartWith("[COMMIT BLOCKED] Not committed: `bun run test` fails.");
		expect(out).toContain("First failure:");
		expect(out).toContain("cli prints");
		// The honesty ledger records the refusal as a failed call, not a commit.
		expect(isErrorToolResult(out)).toBe(true);
		expect(commits()).toBe(1);
	}, 30_000);

	test("`git commit` through run_command is gated the same way", async () => {
		repo(BUN_PKG);
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("run_command", { command: 'git commit -m "feat: done"' });
		expect(out).toStartWith("[COMMIT BLOCKED] Not committed");
		expect(commits()).toBe(1);
	}, 30_000);

	test("a green suite commits", async () => {
		repo(BUN_PKG);
		write("test/more.test.ts", PASS);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "test: more" });
		expect(out).not.toContain("COMMIT GATE");
		expect(commits()).toBe(2);
		expect(runs()).toBe(1);
	}, 30_000);

	test("no test script: commits without running anything", async () => {
		repo({ name: "t", private: true });
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "feat: done" });
		expect(out).not.toContain("COMMIT GATE");
		expect(commits()).toBe(2);
		expect(runs()).toBe(0);
	}, 30_000);

	test("nothing changed since a green run: the suite does not run again", async () => {
		repo(BUN_PKG);
		write("test/more.test.ts", PASS);
		// Nothing staged: the gate runs green, then git refuses the empty commit.
		const first = await ex.execute("git_commit", { message: "test: more" });
		expect(first).not.toContain("COMMIT GATE");
		expect(commits()).toBe(1);
		expect(runs()).toBe(1);
		// Staging does not change the tree's content, so the green result stands.
		await ex.execute("git_add", { files: "." });
		const second = await ex.execute("git_commit", { message: "test: more" });
		expect(second).not.toContain("COMMIT GATE");
		expect(commits()).toBe(2);
		expect(runs()).toBe(1);
	}, 30_000);

	test("red on an unchanged tree: refused twice from cache, then committed and marked red", async () => {
		repo(BUN_PKG);
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const a = await ex.execute("git_commit", { message: "x" });
		const b = await ex.execute("git_commit", { message: "x" });
		expect(a).toStartWith("[COMMIT BLOCKED] Not committed");
		expect(b).toBe(a);
		expect(runs()).toBe(1);
		expect(commits()).toBe(1);
		const c = await ex.execute("git_commit", { message: "x" });
		expect(c).toStartWith("[COMMIT GATE] Committed with `bun run test` still failing");
		expect(commits()).toBe(2);
		expect(runs()).toBe(1);
	}, 30_000);

	test("fixing the test after a refusal reruns the suite and commits", async () => {
		repo(BUN_PKG);
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		expect(await ex.execute("git_commit", { message: "x" })).toStartWith("[COMMIT BLOCKED]");
		write("test/cli.test.ts", `import { $ } from "bun";\n${FAIL}`);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "x" });
		expect(out).not.toContain("COMMIT GATE");
		expect(commits()).toBe(2);
		expect(runs()).toBe(2);
	}, 30_000);

	test("a suite that outlasts the timeout: commits, and says it is not verified", async () => {
		repo({ name: "t", private: true, scripts: { test: "bun ./slow.ts" } });
		process.env.EIGHT_COMMIT_GATE_TIMEOUT_SEC = "1";
		write("slow.ts", "await Bun.sleep(20_000);\n");
		await ex.execute("git_add", { files: "." });
		const started = Date.now();
		const out = await ex.execute("git_commit", { message: "x" });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(out).toContain("[COMMIT GATE] `bun run test` did not finish in 1s");
		expect(commits()).toBe(2);
	}, 30_000);

	test("a test script that calls a missing binary: commits, unverified, never refused", async () => {
		repo({ name: "t", private: true, scripts: { test: "nosuchbin-3402" } });
		write("bun.lock", "");
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "x" });
		expect(out).toStartWith("[COMMIT GATE] `bun run test` could not run (");
		expect(out).toContain("not found");
		expect(out).toContain("so this commit is not verified by the test suite.");
		expect(out).not.toContain("COMMIT BLOCKED");
		expect(isErrorToolResult(out)).toBe(false);
		expect(commits()).toBe(2);
		expect(out).toContain("nosuchbin-3402");
	}, 30_000);

	test("the runner itself is not on PATH (bun, or yarn for a yarn.lock): commits, unverified", async () => {
		const cases = [
			{ lock: "bun.lock", script: "bun ./count.ts", runner: "bun run test" },
			{ lock: "yarn.lock", script: "jest", runner: "yarn test" },
		];
		for (const { lock, script, runner } of cases) {
			repo({ name: "t", private: true, scripts: { test: script } });
			write(lock, "");
			git("add", lock);
			git("commit", "-q", "-m", "lock");
			write("test/cli.test.ts", FAIL);
			await ex.execute("git_add", { files: "." });
			process.env.PATH = NO_RUNNER_PATH;
			const out = await ex.execute("git_commit", { message: "x" });
			process.env.PATH = BUN_FIRST_PATH;
			expect(out).toStartWith(`[COMMIT GATE] \`${runner}\` could not run (`);
			expect(out).toContain("command not found");
			expect(commits()).toBe(3);
			expect(runs()).toBe(0);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("a suite killed by a signal (Exit code null) is red, never cached green", async () => {
		repo(BUN_PKG);
		write("test/cli.test.ts", FAIL);
		git("add", ".");
		let calls = 0;
		const gate = new CommitGate(dir, async () => {
			calls++;
			return formatCommandOutput(null, "", "Segmentation fault");
		});
		const a = await gate.check();
		expect(a.commit).toBe(false);
		if (!a.commit)
			expect(a.message).toStartWith("[COMMIT BLOCKED] Not committed: `bun run test` was killed");
		const b = await gate.check();
		expect(b.commit).toBe(false);
		expect(calls).toBe(1);
	}, 30_000);

	test("a test script killed by a signal blocks the commit end to end", async () => {
		repo({ name: "t", private: true, scripts: { test: "bun test; kill -9 $$" } });
		write("bun.lock", "");
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "x" });
		expect(out).toStartWith("[COMMIT BLOCKED]");
		expect(commits()).toBe(1);
	}, 30_000);

	test("output the gate does not recognise is unverified, not green", async () => {
		repo(BUN_PKG);
		write("test/more.test.ts", PASS);
		git("add", ".");
		for (const out of ["", "[SOMETHING ELSE] odd", "Error: spawn failed"]) {
			const d = await new CommitGate(dir, async () => out).check();
			expect(d.commit).toBe(true);
			if (d.commit) expect(d.note).toContain("so this commit is not verified by the test suite.");
		}
	}, 30_000);

	test("exit 127 with no not-found line is red (`|| exit 127`)", async () => {
		repo({ name: "t", private: true, scripts: { test: "bun test || exit 127" } });
		write("bun.lock", "");
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "x" });
		expect(out).toStartWith("[COMMIT BLOCKED] Not committed: `bun run test` fails.");
		expect(commits()).toBe(1);
	}, 30_000);

	test("secrets are scrubbed before the tail is cut, so no fragment survives", async () => {
		repo(BUN_PKG);
		write("test/more.test.ts", PASS);
		git("add", ".");
		const token = `ghp_${"A1b2C3d4E5".repeat(3)}xyzXYZ`;
		// Put the token across the 4000-character cut.
		const body = `${"x".repeat(100)}\n${token}\n${"y".repeat(3990)}`;
		const d = await new CommitGate(dir, async () => formatCommandOutput(1, body, "")).check();
		expect(d.commit).toBe(false);
		if (!d.commit) {
			expect(d.message).not.toContain(token.slice(-20));
			expect(d.message).not.toContain(token.slice(0, 12));
		}
		const first = await new CommitGate(dir, async () =>
			formatCommandOutput(1, `(fail) leaked ${token}`, ""),
		).check();
		if (!first.commit) expect(first.message).not.toContain(token);
		const notFound = await new CommitGate(dir, async () =>
			formatCommandOutput(127, `sh: ${token}: command not found`, ""),
		).check();
		expect(notFound.commit).toBe(true);
		if (notFound.commit) {
			expect(notFound.note).toContain("[REDACTED:github_token]");
			expect(notFound.note).not.toContain(token);
		}
	}, 30_000);

	test("env-prefixed and quoted-option commits through run_command are gated", async () => {
		repo(BUN_PKG);
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		for (const command of [
			"GIT_AUTHOR_NAME=x git commit -m feat",
			'git -c "user.name=a b" commit -m feat',
			"env git commit -m feat",
			"/usr/bin/git commit -m feat",
		]) {
			// A fresh session each time, so no attempt reuses another's refusal count.
			freshExecutor();
			const out = await ex.execute("run_command", { command });
			expect(out).toStartWith("[COMMIT BLOCKED]");
		}
		expect(commits()).toBe(1);
	}, 30_000);

	test("`git -C <dir> commit` is not verified against the wrong tree", async () => {
		repo(BUN_PKG);
		mkdirSync(join(dir, "sub"));
		git("init", "-q", "-b", "main", "sub");
		write("sub/a.txt", "a\n");
		Bun.spawnSync(["git", "-C", "sub", "add", "."], { cwd: dir });
		write("test/cli.test.ts", FAIL);
		const out = await ex.execute("run_command", {
			command: "git -C sub -c user.name=t -c user.email=t@example.com commit -m x",
		});
		expect(out).toStartWith(
			"[COMMIT GATE] This commit targets `sub`, not the working directory, so the test suite was not run for it",
		);
		expect(runs()).toBe(0);
	}, 30_000);

	test("green on the working tree with unstaged changes says what the commit holds is not verified", async () => {
		repo(BUN_PKG);
		write("test/b.test.ts", FAIL);
		git("add", ".");
		write("test/b.test.ts", PASS);
		const out = await ex.execute("git_commit", { message: "x" });
		expect(out).toStartWith(
			"[COMMIT GATE] The suite passed on the working tree, but some changes are not staged",
		);
		expect(commits()).toBe(2);
	}, 30_000);

	test("a .txt test fixture or code under docs/ still runs the suite", async () => {
		for (const file of ["test/fixtures/expected.txt", "docs/gen.ts"]) {
			repo(BUN_PKG);
			write(file, "x\n");
			await ex.execute("git_add", { files: "." });
			await ex.execute("git_commit", { message: "x" });
			expect(runs()).toBe(1);
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	test("only docs changed: no suite run", async () => {
		repo(BUN_PKG);
		write("README.md", "# t\n");
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "docs" });
		expect(out).not.toContain("COMMIT GATE");
		expect(commits()).toBe(2);
		expect(runs()).toBe(0);
	}, 30_000);

	test("EIGHT_COMMIT_GATE=0 turns it off", async () => {
		repo(BUN_PKG);
		process.env.EIGHT_COMMIT_GATE = "0";
		write("test/cli.test.ts", FAIL);
		await ex.execute("git_add", { files: "." });
		const out = await ex.execute("git_commit", { message: "x" });
		expect(out).not.toContain("COMMIT GATE");
		expect(commits()).toBe(2);
		expect(runs()).toBe(0);
	}, 30_000);
});

describe("parseGitCommit", () => {
	const rows: Array<[string, { all: boolean; dir: string; gitDir: boolean } | null]> = [
		['git commit -m "x"', { all: false, dir: ".", gitDir: false }],
		["git commit", { all: false, dir: ".", gitDir: false }],
		["git -c user.name=a commit --amend", { all: false, dir: ".", gitDir: false }],
		["VAR=x git commit -m x", { all: false, dir: ".", gitDir: false }],
		[
			"GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=b git commit -m x",
			{ all: false, dir: ".", gitDir: false },
		],
		["env git commit -m x", { all: false, dir: ".", gitDir: false }],
		["env -u HOME A=1 git commit -m x", { all: false, dir: ".", gitDir: false }],
		["command git commit -m x", { all: false, dir: ".", gitDir: false }],
		["/usr/bin/git commit -m x", { all: false, dir: ".", gitDir: false }],
		['git -c "k=v w" commit -m x', { all: false, dir: ".", gitDir: false }],
		["git -c 'k=v w' commit -m x", { all: false, dir: ".", gitDir: false }],
		["git -p commit -m x", { all: false, dir: ".", gitDir: false }],
		["git --no-pager commit -m x", { all: false, dir: ".", gitDir: false }],
		["git --work-tree . commit -m x", { all: false, dir: ".", gitDir: false }],
		["git -C sub commit -m x", { all: false, dir: "sub", gitDir: false }],
		["git -C a -C b commit", { all: false, dir: "a/b", gitDir: false }],
		["git -C . commit", { all: false, dir: ".", gitDir: false }],
		["git --work-tree=other commit", { all: false, dir: "other", gitDir: false }],
		["git --git-dir ../x/.git commit", { all: false, dir: ".", gitDir: true }],
		["git commit -am x", { all: true, dir: ".", gitDir: false }],
		["git commit --all -m x", { all: true, dir: ".", gitDir: false }],
		["git commit --amend -m x", { all: false, dir: ".", gitDir: false }],
		["git add -A\ngit commit -m x", { all: false, dir: ".", gitDir: false }],
		["git log --grep commit", null],
		["git commit-tree abc", null],
		["echo git commit", null],
		['echo "git commit"', null],
		["gitx commit", null],
		["git status", null],
	];
	test.each(rows)("%p", (command, expected) => {
		expect(parseGitCommit(command)).toEqual(expected);
		expect(isGitCommit(command)).toBe(expected !== null);
	});
});
