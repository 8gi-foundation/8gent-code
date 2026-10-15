import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SCRATCH_IGNORE_BODY,
	ensureScratchExcluded,
	ensureScratchExcludedIfPresent,
} from "./scratch-exclude";

const git = (cwd: string, ...a: string[]) =>
	spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const dir = () => mkdtempSync(join(tmpdir(), "scratch-ex-"));

/** Same files the pilot judge hashes (fixtures/judges/lib.ts gitStateDigest). */
const gitFiles = (d: string): string => {
	const out: string[] = [];
	const walk = (rel: string) => {
		const p = join(d, ".git", rel);
		if (!existsSync(p)) return;
		if (statSync(p).isDirectory()) for (const n of readdirSync(p).sort()) walk(`${rel}/${n}`);
		else out.push(`${rel}:${readFileSync(p, "utf8")}`);
	};
	for (const rel of ["config", "HEAD", "info", "refs", "packed-refs"]) walk(rel);
	return out.join("\n");
};

describe("ensureScratchExcluded (#4236, #4316)", () => {
	it("hides .tmp from git status and leaves .git byte-identical", () => {
		const d = dir();
		git(d, "init", "-q");
		git(d, "commit", "-q", "--allow-empty", "-m", "i");
		const before = gitFiles(d);
		mkdirSync(join(d, ".tmp/verify"), { recursive: true });
		writeFileSync(join(d, ".tmp/verify/x.ts"), "x");
		expect(ensureScratchExcluded(d)).toBe(true);
		expect(ensureScratchExcluded(d)).toBe(false);
		expect(readFileSync(join(d, ".tmp/.gitignore"), "utf8")).toBe(SCRATCH_IGNORE_BODY);
		expect(git(d, "status", "--porcelain").stdout).toBe("");
		expect(gitFiles(d)).toBe(before);
	});

	it("does nothing until .tmp/ exists", () => {
		const d = dir();
		git(d, "init", "-q");
		const before = gitFiles(d);
		expect(ensureScratchExcludedIfPresent(d)).toBe(false);
		expect(existsSync(join(d, ".tmp"))).toBe(false);
		expect(gitFiles(d)).toBe(before);
	});

	it("works from a linked worktree", () => {
		const d = dir();
		git(d, "init", "-q");
		git(d, "commit", "-q", "--allow-empty", "-m", "i");
		const wt = join(dir(), "wt");
		expect(git(d, "worktree", "add", "-q", "-b", "b", wt).status).toBe(0);
		mkdirSync(join(wt, ".tmp"));
		writeFileSync(join(wt, ".tmp/x"), "x");
		expect(ensureScratchExcluded(wt)).toBe(true);
		expect(git(wt, "status", "--porcelain").stdout).toBe("");
	});

	it("is a silent no-op outside a git repo", () => {
		const d = dir();
		mkdirSync(join(d, ".tmp"));
		expect(ensureScratchExcluded(d)).toBe(false);
		expect(existsSync(join(d, ".tmp/.gitignore"))).toBe(false);
	});

	it("refuses a symlinked .tmp: nothing is written outside the workspace (#4317)", () => {
		const d = dir();
		const outside = dir();
		git(d, "init", "-q");
		symlinkSync(outside, join(d, ".tmp"));
		expect(ensureScratchExcluded(d)).toBe(false);
		expect(existsSync(join(outside, ".gitignore"))).toBe(false);
	});

	it("refuses a .gitignore symlink to a missing outside path: not created (#4317)", () => {
		const d = dir();
		const outside = join(dir(), "created-by-follow");
		git(d, "init", "-q");
		mkdirSync(join(d, ".tmp"));
		symlinkSync(outside, join(d, ".tmp/.gitignore"));
		expect(ensureScratchExcluded(d)).toBe(false);
		expect(existsSync(outside)).toBe(false);
	});
});
