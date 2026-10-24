/**
 * Durable run storage: one SQLite file under the 8gent data folder, mode 0600 (#4883).
 * The file is created private before SQLite opens it, so its -wal and -shm files inherit 0600,
 * and an older file with looser bits is tightened. Pi Durable (MIT, earendil-works/pi) owns the
 * tables; the effect ledger lives beside them in the same file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

/** A run id becomes a file name: letters, digits, `_` and `-` only, so it can never name another path. */
export const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function defaultRunDb(runId: string): string {
	if (!RUN_ID_RE.test(runId))
		throw new Error(`not a valid run id: ${JSON.stringify(runId).slice(0, 60)}`);
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(base, "runs", `${runId}.sqlite`);
}

/**
 * Make a folder fit to hold a run, BEFORE anything is written into it. A folder this creates is
 * 0700. An existing folder is never re-moded (`8gent durable-run ~` must not chmod the home
 * folder): it must be this user's and not writable by anyone else, or it is refused.
 */
export function preparePrivateFolder(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = fs.statSync(dir);
	if (!st.isDirectory()) throw new Error(`not a folder: ${dir}`);
	if (typeof process.getuid === "function" && st.uid !== process.getuid())
		throw new Error(`folder is not yours: ${dir}`);
	if (st.mode & 0o022)
		throw new Error(`folder is writable by others, refusing to keep a run in it: ${dir}`);
}

const F = fs.constants;

/** Write a 0600 file, never through a link at its name (O_NOFOLLOW). `exclusive`: it must be new. */
export function writeFileNoFollow(
	file: string,
	data: string,
	opts: { exclusive?: boolean } = {},
): void {
	const flags = F.O_WRONLY | F.O_CREAT | F.O_NOFOLLOW | (opts.exclusive ? F.O_EXCL : F.O_TRUNC);
	const fd = fs.openSync(file, flags, 0o600);
	try {
		fs.writeSync(fd, data);
	} finally {
		fs.closeSync(fd);
	}
}

/** Append to a 0600 file, never through a link at its name. */
export function appendFileNoFollow(file: string, data: string): void {
	const fd = fs.openSync(file, F.O_WRONLY | F.O_APPEND | F.O_CREAT | F.O_NOFOLLOW, 0o600);
	try {
		fs.writeSync(fd, data);
	} finally {
		fs.closeSync(fd);
	}
}

/** Read a file, never through a link at its name. */
export function readFileNoFollow(file: string): string {
	const fd = fs.openSync(file, F.O_RDONLY | F.O_NOFOLLOW);
	try {
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** A subfolder of the run that is a real folder, not a link someone put in its place. */
export function ensureRealSubfolder(parent: string, name: string): string {
	const dir = path.join(parent, name);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const st = fs.lstatSync(dir);
	if (!st.isDirectory()) throw new Error(`${dir} is not a plain folder`);
	return dir;
}

/** `rel` as a path under `root`: never above it, never through a link, however it is spelled. */
export function resolveInside(root: string, rel: string): string {
	const base = fs.realpathSync(root);
	const target = path.resolve(base, rel);
	if (!target.startsWith(base + path.sep)) throw new Error("path is outside the run folder");
	// Every folder on the way must be real and inside: realpath the deepest one that exists.
	let probe = path.dirname(target);
	while (!fs.existsSync(probe) && probe !== base) probe = path.dirname(probe);
	const real = fs.realpathSync(probe);
	if (real !== base && !real.startsWith(base + path.sep))
		throw new Error("path leaves the run folder through a link");
	return target;
}

/**
 * Create or tighten the file: 0600, regular files only, never through a link, in a folder that
 * passed preparePrivateFolder.
 */
export function preparePrivateFile(file: string): void {
	const dir = path.dirname(file);
	preparePrivateFolder(dir);
	const fd = fs.openSync(
		file,
		fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
		0o600,
	);
	try {
		if (!fs.fstatSync(fd).isFile()) throw new Error(`not a regular file: ${file}`);
		fs.fchmodSync(fd, 0o600);
	} finally {
		fs.closeSync(fd);
	}
}

export async function openRunDatabase(file: string): Promise<SqliteDatabase> {
	preparePrivateFile(file);
	return openNodeSqliteDatabase(file);
}

export async function openRunStorage(
	file: string,
	wrap: (db: SqliteDatabase) => SqliteDatabase = (d) => d,
): Promise<SqliteStorage> {
	return SqliteStorage.open(wrap(await openRunDatabase(file)));
}
