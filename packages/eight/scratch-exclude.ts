/**
 * Keep the session scratch dir (`.tmp/`) out of git status without touching the
 * committed .gitignore (#4236) and without touching the git directory (#4316).
 * The dir carries its own `.gitignore` containing `*`: git then ignores every file in
 * it, the `.gitignore` included, so status stays clean and `.git/` stays byte-identical
 * (the SIGI nothing-committed digest hashes config, hooks, info and refs).
 * Idempotent; silent no-op when `.tmp/` is absent or not inside a git work tree.
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const SCRATCH_DIR = ".tmp";
export const SCRATCH_IGNORE_BODY = "*\n";

/** Returns true when the ignore file was written, false when already present or not applicable. */
export function ensureScratchExcluded(cwd: string): boolean {
	try {
		const dir = resolve(cwd, SCRATCH_DIR);
		if (!existsSync(dir)) return false;
		const file = resolve(dir, ".gitignore");
		if (existsSync(file)) return false;
		// Read-only probe: rev-parse never writes to .git, unlike status (index refresh).
		const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd,
			encoding: "utf8",
			timeout: 5000,
		});
		if (r.status !== 0 || r.stdout.trim() !== "true") return false;
		writeFileSync(file, SCRATCH_IGNORE_BODY);
		return true;
	} catch {
		return false;
	}
}

/** Kept for the call site in tools.ts: the dir must already exist, which ensureScratchExcluded checks. */
export const ensureScratchExcludedIfPresent = ensureScratchExcluded;
