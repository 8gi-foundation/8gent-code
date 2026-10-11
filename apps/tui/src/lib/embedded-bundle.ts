/**
 * The TUI bundle inside a compiled 8gent binary (#2975, hardened in #3894).
 *
 * `bun build --compile` embeds dist/tui.js, but Bun can only execute a real
 * file. materializeTui() writes it to a private cache directory and returns the
 * path; childInvocation() says how the binary runs it as its own Bun runtime.
 *
 * Trust rules, because the cached file is executed with the user's rights:
 *  - the file is re-hashed (full sha256) on EVERY launch and rewritten on mismatch;
 *  - the cache dir is a real directory, owned by us, mode 0700 (POSIX);
 *  - writes go to a random exclusive-create 0600 temp name, then an atomic rename;
 *  - nothing from the working directory (bunfig.toml preload, .env) is loaded.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const NAME_RE = /^tui-[0-9a-f]{16}\.js$/;
const TMP_RE = /^tui-[0-9a-f]{16}\.js\.[0-9a-f]{16}\.tmp$/;
const STALE_TMP_MS = 60 * 60 * 1000;
export const EMPTY_CONFIG = "empty-bunfig.toml";

const sha256 = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");

function fileMatches(file: string, digest: string): boolean {
	try {
		const st = fs.lstatSync(file);
		if (!st.isFile()) return false; // a symlink or directory is never trusted
		return sha256(fs.readFileSync(file)) === digest;
	} catch {
		return false;
	}
}

/** The cache dir must be a real directory we own, not group/world writable. */
function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	try {
		fs.mkdirSync(dir, { mode: 0o700 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	const st = fs.lstatSync(dir);
	if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`cache path is not a directory: ${dir}`);
	if (process.platform !== "win32") {
		if (typeof process.getuid === "function" && st.uid !== process.getuid())
			throw new Error(`cache dir is not owned by this user: ${dir}`);
		if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
	}
}

function writeExclusive(dir: string, final: string, bytes: Uint8Array | Buffer): void {
	const tmp = path.join(dir, `${path.basename(final)}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		const fd = fs.openSync(tmp, "wx", 0o600); // O_EXCL: never follows a planted symlink
		try {
			fs.writeSync(fd, bytes);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, final);
	} finally {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {}
	}
}

function prune(dir: string, keep: string): void {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const n of names) {
		const p = path.join(dir, n);
		try {
			if (NAME_RE.test(n) && n !== keep) fs.rmSync(p, { force: true });
			else if (TMP_RE.test(n) && Date.now() - fs.lstatSync(p).mtimeMs > STALE_TMP_MS)
				fs.rmSync(p, { force: true });
		} catch {}
	}
}

/** Returns the path of a hash-verified copy of `bytes` in `dir`. Throws if none can be trusted. */
export function materializeTui(bytes: Uint8Array | Buffer, dir: string): string {
	const digest = sha256(bytes);
	const target = path.join(dir, `tui-${digest.slice(0, 16)}.js`);
	ensurePrivateDir(dir);
	if (fileMatches(target, digest)) return target;
	fs.rmSync(target, { force: true, recursive: false }); // tampered, truncated or a symlink
	try {
		writeExclusive(dir, target, bytes);
	} catch (e) {
		// Two first launches racing (Windows rename onto an open file gives EPERM/EEXIST/EBUSY):
		// the other writer's copy is fine if, and only if, it hashes right.
		const code = (e as NodeJS.ErrnoException).code;
		if (!(code === "EPERM" || code === "EEXIST" || code === "EBUSY" || code === "EACCES")) throw e;
	}
	if (!fileMatches(target, digest)) throw new Error("cached TUI bundle failed verification");
	prune(dir, path.basename(target));
	return target;
}

/** A zero-byte bunfig in the private dir, so the child never reads $cwd/bunfig.toml. */
export function emptyConfig(dir: string): string {
	const file = path.join(dir, EMPTY_CONFIG);
	ensurePrivateDir(dir);
	if (!fileMatches(file, sha256(new Uint8Array()))) {
		fs.rmSync(file, { force: true });
		try {
			writeExclusive(dir, file, new Uint8Array());
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (!(code === "EPERM" || code === "EEXIST" || code === "EBUSY" || code === "EACCES")) throw e;
		}
	}
	return file;
}

/**
 * How the compiled binary runs the bundle as its own Bun runtime, in the user's
 * working directory but without trusting it: no auto-install, no .env files, an
 * explicit empty config. User args follow the script path, so Bun never parses them.
 */
export function childInvocation(
	execPath: string,
	bundle: string,
	userArgs: string[],
	dir: string,
	baseEnv: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
	return {
		command: execPath,
		args: ["run", "--no-install", "--no-env-file", `--config=${emptyConfig(dir)}`, bundle, ...userArgs],
		env: { ...baseEnv, BUN_BE_BUN: "1" },
	};
}
