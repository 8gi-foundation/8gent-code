import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRATCH_EXCLUDE_LINE, ensureScratchExcluded } from "./scratch-exclude";

const git = (cwd: string, ...a: string[]) =>
	spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const dir = () => mkdtempSync(join(tmpdir(), "scratch-ex-"));
const count = (f: string) =>
	readFileSync(f, "utf8")
		.split("\n")
		.filter((l) => l === SCRATCH_EXCLUDE_LINE).length;

describe("ensureScratchExcluded (#4236)", () => {
	it("adds .tmp/ once and is idempotent; git status hides .tmp", () => {
		const d = dir();
		git(d, "init", "-q");
		expect(ensureScratchExcluded(d)).toBe(true);
		expect(ensureScratchExcluded(d)).toBe(false);
		expect(count(join(d, ".git/info/exclude"))).toBe(1);
		spawnSync("mkdir", ["-p", join(d, ".tmp/verify")]);
		writeFileSync(join(d, ".tmp/verify/x.ts"), "x");
		expect(git(d, "status", "--porcelain").stdout).toBe("");
	});

	it("appends on a new line when the file lacks a trailing newline", () => {
		const d = dir();
		git(d, "init", "-q");
		const f = join(d, ".git/info/exclude");
		writeFileSync(f, "foo");
		ensureScratchExcluded(d);
		expect(readFileSync(f, "utf8")).toBe("foo\n.tmp/\n");
	});

	it("resolves the shared exclude file from a linked worktree", () => {
		const d = dir();
		git(d, "init", "-q");
		git(d, "commit", "-q", "--allow-empty", "-m", "i");
		const wt = join(dir(), "wt");
		expect(git(d, "worktree", "add", "-q", "-b", "b", wt).status).toBe(0);
		expect(ensureScratchExcluded(wt)).toBe(true);
		expect(count(join(d, ".git/info/exclude"))).toBe(1);
	});

	it("is a silent no-op outside a git repo", () => {
		const d = dir();
		expect(ensureScratchExcluded(d)).toBe(false);
	});
});
