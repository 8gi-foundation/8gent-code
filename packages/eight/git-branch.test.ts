import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitBranch } from "./git-branch";

const dirs: string[] = [];
function repo(head: string): string {
	const root = mkdtempSync(join(tmpdir(), "git-branch-"));
	dirs.push(root);
	mkdirSync(join(root, ".git"));
	writeFileSync(join(root, ".git", "HEAD"), head);
	return root;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readGitBranch", () => {
	test("branch name from HEAD, from a nested folder too", () => {
		const root = repo("ref: refs/heads/fix/tui-thing\n");
		expect(readGitBranch(root)).toBe("fix/tui-thing");
		mkdirSync(join(root, "a", "b"), { recursive: true });
		expect(readGitBranch(join(root, "a", "b"))).toBe("fix/tui-thing");
	});

	test("detached HEAD reads as HEAD, like rev-parse --abbrev-ref", () => {
		expect(readGitBranch(repo("73a2d36f64468c7ea131b16e577ea374276d9861\n"))).toBe("HEAD");
	});

	test("a worktree's .git file points at its own HEAD", () => {
		const main = repo("ref: refs/heads/main\n");
		const wtGit = join(main, ".git", "worktrees", "w");
		mkdirSync(wtGit, { recursive: true });
		writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/feature\n");
		const wt = mkdtempSync(join(tmpdir(), "git-branch-wt-"));
		dirs.push(wt);
		writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
		expect(readGitBranch(wt)).toBe("feature");
	});

	test("matches git itself on this checkout", () => {
		const r = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: import.meta.dir });
		if (r.exitCode !== 0) return;
		expect(readGitBranch(import.meta.dir)).toBe(r.stdout.toString().trim());
	});

	test("starts no process", () => {
		const cp = require("node:child_process");
		const calls: string[] = [];
		const orig = { exec: cp.exec, execFile: cp.execFile, spawn: cp.spawn, spawnSync: cp.spawnSync };
		for (const k of Object.keys(orig)) cp[k] = (...a: unknown[]) => calls.push(`${k} ${a[0]}`);
		try {
			readGitBranch(repo("ref: refs/heads/main\n"));
		} finally {
			Object.assign(cp, orig);
		}
		expect(calls).toEqual([]);
	});
});
