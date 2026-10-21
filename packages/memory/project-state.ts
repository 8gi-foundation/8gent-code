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

const HASH_LENGTHS = [12, 24, 40];
const MARKER = "repo.path";

function hashOf(repo: string, len: number): string {
	return createHash("sha1").update(absRepo(repo)).digest("hex").slice(0, len);
}

function readMarker(dir: string): string | null {
	try {
		return fs.readFileSync(path.join(dir, MARKER), "utf8");
	} catch {
		return null;
	}
}

/**
 * `<data dir>/projects/<hash>`, the hash being the first 12 hex chars of sha1(abs repo path).
 * The dir holds `repo.path` (the realpath it was made for); on a mismatch (a hash collision or a
 * planted dir) the next longer hash is used. `create` writes the marker and logs one line on a mismatch.
 */
function resolveStateDir(repo: string, create: boolean): string {
	const abs = absRepo(repo);
	let dir = "";
	for (const len of HASH_LENGTHS) {
		dir = path.join(dataDir(), "projects", hashOf(repo, len));
		const marker = readMarker(dir);
		if (marker === abs) return dir;
		if (marker === null) {
			if (create) {
				try {
					fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(path.join(dir, MARKER), abs, { flag: "wx" });
				} catch {
					// another process won the race: re-read on the next open
				}
			}
			return dir;
		}
		if (create)
			console.error(`[memory] ${dir} belongs to ${marker}, not ${abs}: using a longer hash`);
	}
	return dir;
}

export function projectStateDir(repo: string): string {
	return resolveStateDir(repo, false);
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

function isRegular(file: string): boolean {
	try {
		const st = fs.lstatSync(file);
		return st.isFile() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

function isRealDir(dir: string): boolean {
	try {
		const st = fs.lstatSync(dir);
		return st.isDirectory() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Copy `<repo>/.8gent/memory/memory.db` (and its -wal/-shm, project.jsonl) to `destDir` once: only
 * when the old one is a regular file (a symlink planted in the repo is never followed) and the new
 * one does not exist (never overwritten: COPYFILE_EXCL, and a symlink at the destination is refused).
 * Never deletes the old one. One log line.
 */
export function migrateRepoMemory(repo: string, destDir: string): boolean {
	try {
		const legacyDir = path.join(repo, ".8gent", "memory");
		const legacy = path.join(legacyDir, "memory.db");
		const dest = path.join(destDir, "memory.db");
		if (!isRealDir(path.join(repo, ".8gent")) || !isRealDir(legacyDir) || !isRegular(legacy))
			return false;
		if (fs.lstatSync(dest, { throwIfNoEntry: false })) return false;
		// Run from HOME: the legacy dir is the global store, which is not this repo's to copy.
		const globalDir = path.join(dataDir(), "memory");
		if (fs.existsSync(globalDir) && fs.realpathSync(globalDir) === fs.realpathSync(legacyDir))
			return false;
		fs.mkdirSync(destDir, { recursive: true });
		for (const name of ["memory.db", "memory.db-wal", "memory.db-shm", "project.jsonl"]) {
			const src = path.join(legacyDir, name);
			const to = path.join(destDir, name);
			if (!isRegular(src) || fs.lstatSync(to, { throwIfNoEntry: false })) continue;
			try {
				fs.copyFileSync(src, to, fs.constants.COPYFILE_EXCL);
			} catch {
				// exists or unreadable: leave it
			}
		}
		console.error(`[memory] moved project memory from ${legacyDir} to ${destDir}`);
		return true;
	} catch {
		return false;
	}
}

/** Resolve the project memory dir for a repo, doing the one-time migration or the opt-in ignore line. */
export function prepareProjectMemoryDir(repo: string): string {
	if (projectStateInRepo()) {
		ensureEightIgnored(repo);
		return projectMemoryDir(repo);
	}
	const dir = path.join(resolveStateDir(repo, true), "memory");
	migrateRepoMemory(repo, dir);
	return dir;
}
