/**
 * Where a repo's project-scoped memory lives (#4711).
 *
 * Default: `<data dir>/projects/<sha1 of the repo's absolute path, 12 chars>/memory/`,
 * outside the repo, so a run leaves `git status` as it found it. Opt-in
 * `EIGHT_PROJECT_STATE_IN_REPO=1` keeps the old `<repo>/.8gent/memory/` and adds
 * `.8gent/` to the repo's .gitignore in the same step. An existing repo-local store is
 * copied once to the new place when the new one is absent.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PROJECT_STATE_IN_REPO_ENV = "EIGHT_PROJECT_STATE_IN_REPO";

export function dataDir(): string {
	return process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
}

export function projectStateInRepo(): boolean {
	return process.env[PROJECT_STATE_IN_REPO_ENV] === "1";
}

function absRepo(repo: string): string {
	const abs = path.resolve(repo);
	try {
		return fs.realpathSync(abs);
	} catch {
		return abs;
	}
}

/** `<data dir>/projects/<12 hex of sha1(abs repo path)>` */
export function projectStateDir(repo: string): string {
	const hash = createHash("sha1").update(absRepo(repo)).digest("hex").slice(0, 12);
	return path.join(dataDir(), "projects", hash);
}

/** The directory holding this repo's project memory (memory.db, project.jsonl). */
export function projectMemoryDir(repo: string): string {
	return projectStateInRepo()
		? path.join(repo, ".8gent", "memory")
		: path.join(projectStateDir(repo), "memory");
}

/** Append `.8gent/` to the repo's .gitignore unless a line already covers it. Returns true when written. */
export function ensureEightIgnored(repo: string): boolean {
	try {
		const file = path.join(repo, ".gitignore");
		const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		if (text.split(/\r?\n/).some((l) => /^\/?\.8gent\/?\*?$/.test(l.trim()))) return false;
		const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
		fs.appendFileSync(file, `${sep}.8gent/\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Copy `<repo>/.8gent/memory/memory.db` (and its -wal/-shm) to `destDir` once: only when
 * the old one exists and the new one does not. Never deletes the old one. One log line.
 */
export function migrateRepoMemory(repo: string, destDir: string): boolean {
	try {
		const legacyDir = path.join(repo, ".8gent", "memory");
		const legacy = path.join(legacyDir, "memory.db");
		const dest = path.join(destDir, "memory.db");
		if (!fs.existsSync(legacy) || fs.existsSync(dest)) return false;
		// Run from HOME: the legacy dir is the global store, which is not this repo's to copy.
		const globalDir = path.join(dataDir(), "memory");
		if (fs.existsSync(globalDir) && fs.realpathSync(globalDir) === fs.realpathSync(legacyDir))
			return false;
		fs.mkdirSync(destDir, { recursive: true });
		for (const suffix of ["", "-wal", "-shm"]) {
			if (fs.existsSync(legacy + suffix)) fs.copyFileSync(legacy + suffix, dest + suffix);
		}
		for (const f of ["project.jsonl"]) {
			const src = path.join(legacyDir, f);
			if (fs.existsSync(src) && !fs.existsSync(path.join(destDir, f)))
				fs.copyFileSync(src, path.join(destDir, f));
		}
		console.error(`[memory] moved project memory from ${legacyDir} to ${destDir}`);
		return true;
	} catch {
		return false;
	}
}

/** Resolve the project memory dir for a repo, doing the one-time migration or the opt-in ignore line. */
export function prepareProjectMemoryDir(repo: string): string {
	const dir = projectMemoryDir(repo);
	if (projectStateInRepo()) ensureEightIgnored(repo);
	else migrateRepoMemory(repo, dir);
	return dir;
}
