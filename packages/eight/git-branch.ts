import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The current git branch for `cwd`, read from HEAD without starting git (#4682):
 * a process start at boot is one more chance to stall the main thread on Termux.
 * Same answers as `git rev-parse --abbrev-ref HEAD`: the branch name, "HEAD" when
 * detached, null outside a repository. Handles worktrees (`.git` file) too.
 */
export function readGitBranch(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		const head = headFile(path.join(dir, ".git"));
		if (head) {
			let text: string;
			try {
				text = fs.readFileSync(head, "utf8").trim();
			} catch {
				return null;
			}
			const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
			if (ref) return ref[1];
			return /^[0-9a-f]{40,64}$/.test(text) ? "HEAD" : null;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function headFile(dotGit: string): string | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dotGit);
	} catch {
		return null;
	}
	if (stat.isDirectory()) return path.join(dotGit, "HEAD");
	try {
		const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
		if (!m) return null;
		return path.join(path.resolve(path.dirname(dotGit), m[1].trim()), "HEAD");
	} catch {
		return null;
	}
}
