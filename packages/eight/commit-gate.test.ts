/**
 * #3402: the agent committed after its own `bun test` returned exit 1 (pilot run
 * 2026-10-03_180159, l5-feature-e2e). git_commit and `git commit` through run_command
 * now run the repo's test script first and refuse a red suite. Driven through the real
 * ToolExecutor in throwaway git repos.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGitCommit } from "./commit-gate";
import { isErrorToolResult } from "./honesty";
import { ToolExecutor } from "./tools";

const PASS = 'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n';
// The pilot's shape: Bun's `$` used without importing it.
const FAIL =
	'import { expect, test } from "bun:test";\ntest("cli prints", async () => {\n\tconst out = await $`echo hi`.text();\n\texpect(out).toBe("hi\\n");\n});\n';
// Counts suite runs in .git/, which git status never sees, so counting does not change the tree.
const COUNT =
	'import { appendFileSync } from "node:fs";\nappendFileSync(".git/gate-runs", "x");\nconst r = Bun.spawnSync(["bun", "test"], { stdout: "inherit", stderr: "inherit" });\nprocess.exit(r.exitCode ?? 1);\n';

let dir: string;
let ex: ToolExecutor;
const saved = { gate: process.env.EIGHT_COMMIT_GATE, t: process.env.EIGHT_COMMIT_GATE_TIMEOUT_SEC };

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
	ex = new ToolExecutor(dir, "commit-gate-test");
	const pm = (ex as unknown as { permissionManager: { checkPermission: () => string } })
		.permissionManager;
	pm.checkPermission = () => "allowed";
}

const BUN_PKG = { name: "t", private: true, scripts: { test: "bun ./count.ts" } };

beforeEach(() => {
	delete process.env.EIGHT_COMMIT_GATE;
	delete process.env.EIGHT_COMMIT_GATE_TIMEOUT_SEC;
});
afterEach(() => {
	for (const [k, v] of [
		["EIGHT_COMMIT_GATE", saved.gate],
		["EIGHT_COMMIT_GATE_TIMEOUT_SEC", saved.t],
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

describe("isGitCommit", () => {
	test("matches commits, not other git commands", () => {
		expect(isGitCommit('git commit -m "x"')).toBe(true);
		expect(isGitCommit("git -c user.name=a commit --amend")).toBe(true);
		expect(isGitCommit("git -C sub commit")).toBe(true);
		expect(isGitCommit("git commit")).toBe(true);
		expect(isGitCommit("git log --grep commit")).toBe(false);
		expect(isGitCommit("git commit-tree abc")).toBe(false);
		expect(isGitCommit("echo git commit")).toBe(false);
	});
});
