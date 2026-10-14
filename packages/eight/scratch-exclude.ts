/**
 * Keep the session scratch dir (`.tmp/`) out of git status without touching
 * the committed .gitignore (#4236). Writes `.tmp/` to the repo's local
 * info/exclude, resolved with git so linked worktrees land on the right file.
 * Idempotent; silent no-op outside a git repo.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SCRATCH_EXCLUDE_LINE = ".tmp/";

/** Returns true when the line was added, false when already present or not a repo. */
export function ensureScratchExcluded(cwd: string): boolean {
	try {
		const r = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], {
			cwd,
			encoding: "utf8",
			timeout: 5000,
		});
		if (r.status !== 0) return false;
		const out = (r.stdout ?? "").trim();
		if (!out) return false;
		const file = resolve(cwd, out);
		const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
		if (lines.some((l) => l.trim() === SCRATCH_EXCLUDE_LINE || l.trim() === ".tmp")) return false;
		mkdirSync(dirname(file), { recursive: true });
		if (!existsSync(file)) {
			writeFileSync(file, `${SCRATCH_EXCLUDE_LINE}\n`);
		} else {
			const text = readFileSync(file, "utf8");
			appendFileSync(
				file,
				`${text.length > 0 && !text.endsWith("\n") ? "\n" : ""}${SCRATCH_EXCLUDE_LINE}\n`,
			);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Lazy form (#4241): touch .git/info/exclude only once `.tmp/` actually exists
 * in the working directory, so a session that never writes scratch leaves the
 * git directory byte-identical (the SIGI nothing-committed digest hashes info/).
 */
export function ensureScratchExcludedIfPresent(cwd: string): boolean {
	try {
		if (!existsSync(resolve(cwd, ".tmp"))) return false;
		return ensureScratchExcluded(cwd);
	} catch {
		return false;
	}
}
