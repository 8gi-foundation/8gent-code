/**
 * 8gent Code - /goal State HMAC (issue #2609, epic #2605)
 *
 * Signs `.go-state.json` so a resumed /goal run cannot be tampered with
 * between sessions. Uses a daemon-resident HMAC key at
 * `~/.8gent/keys/state-hmac.key`. The key is generated on first use,
 * 32 bytes, chmod 0600. Verify mismatch => refuse to resume.
 *
 * The data dir is taken from the security env snapshot (#4132), never from
 * live process.env, so a repo .env or a later env change cannot point
 * signing at a fresh, attacker-chosen key. A key inside the project
 * directory is refused.
 *
 * Owner: 8SO.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { realpathLoose, securityEnvSnapshot } from "./run-command-sandbox.js";

/**
 * Where the HMAC key lives on disk: <data dir>/keys/state-hmac.key.
 *
 * The data dir is EIGHT_DATA_DIR from the startup security env snapshot
 * (absolute only, and ignored when a .env declares it), else <home>/.8gent,
 * where home is resolveHome() over the snapshot's EIGHT_HOME, HOME and
 * USERPROFILE. Neither is read from live process.env, so the key cannot be
 * redirected after startup (#4132). Throws when the key's real path is inside the current
 * project directory: the repo being worked on cannot hold the key that signs
 * its own state. Running from home itself, or from one of its ancestors, is
 * not a cloned repo and is allowed.
 */
export function getKeyPath(): string {
	const v = securityEnvSnapshot().values;
	const dataDir = v.EIGHT_DATA_DIR;
	// The fallback dir and the run-from-home exemption both come from the snapshot (8SO, Artale).
	const home = resolveHome({ EIGHT_HOME: v.EIGHT_HOME, HOME: v.HOME, USERPROFILE: v.USERPROFILE });
	const base = dataDir && path.isAbsolute(dataDir) ? dataDir : path.join(home, ".8gent");
	const keyPath = path.join(base, "keys", "state-hmac.key");
	const project = realpathLoose(process.cwd());
	const realHome = realpathLoose(home);
	const homeIsInProject = realHome === project || realHome.startsWith(project + path.sep);
	const real = realpathLoose(keyPath);
	if (!homeIsInProject && (real === project || real.startsWith(project + path.sep))) {
		throw new Error(
			`[goal-state-hmac] Refusing HMAC key path ${JSON.stringify(real)}: it is inside the project directory ${JSON.stringify(project)}.`,
		);
	}
	return keyPath;
}

/** Key length in bytes. 32 = 256 bits, matches HMAC-SHA256 block. */
const KEY_BYTES = 32;

/** O_NOFOLLOW where the platform has it (not on Windows): open never follows a symlink. */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Refuse a key file that is not a regular file owned by this user with no
 * group or other permission bits (#4132, 8SO). Windows has neither uid nor
 * POSIX mode bits, so only the regular-file check applies there.
 */
function assertTrustedKeyStat(st: fs.Stats, keyPath: string): void {
	const refuse = (why: string) => {
		throw new Error(`[goal-state-hmac] Refusing key at ${keyPath}: ${why}.`);
	};
	if (st.isSymbolicLink()) refuse("it is a symlink");
	if (!st.isFile()) refuse("it is not a regular file");
	if (process.platform === "win32") return;
	if (typeof process.getuid === "function" && st.uid !== process.getuid())
		refuse(`it is owned by uid ${st.uid}, not ${process.getuid()}`);
	if ((st.mode & 0o077) !== 0)
		refuse(`its mode ${(st.mode & 0o777).toString(8)} allows group or other access`);
}

function readExistingKey(keyPath: string): Buffer {
	assertTrustedKeyStat(fs.lstatSync(keyPath), keyPath);
	const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | O_NOFOLLOW);
	try {
		// Re-check the opened file: the path may have been swapped after the lstat.
		assertTrustedKeyStat(fs.fstatSync(fd), keyPath);
		const raw = fs.readFileSync(fd);
		if (raw.length !== KEY_BYTES) {
			throw new Error(
				`[goal-state-hmac] Existing key at ${keyPath} has wrong length (${raw.length} bytes, expected ${KEY_BYTES}). Refusing to use.`,
			);
		}
		return raw;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Load the HMAC key from disk. Generates one on first use with 0600
 * perms in a 0700 dir. Throws if the key file exists but is a symlink,
 * not a regular file, owned by another user, readable or writable by
 * group or other, the wrong size, or cannot be read (#4132).
 */
export function loadOrCreateKey(): Buffer {
	const keyPath = getKeyPath();
	const dir = path.dirname(keyPath);

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	let exists = true;
	try {
		fs.lstatSync(keyPath);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		exists = false;
	}
	if (exists) return readExistingKey(keyPath);

	// Generate a fresh key. O_EXCL: never write through a file or link planted
	// between the check and the create; a lost race reads the winner's key instead.
	const fresh = crypto.randomBytes(KEY_BYTES);
	let fd: number;
	try {
		fd = fs.openSync(
			keyPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
			0o600,
		);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return readExistingKey(keyPath);
		throw e;
	}
	try {
		fs.writeFileSync(fd, fresh);
		try {
			// Defend against umask on platforms that ignore mode at create time.
			fs.fchmodSync(fd, 0o600);
		} catch {
			// chmod on Windows is best-effort; key file still exists.
		}
	} finally {
		fs.closeSync(fd);
	}
	return fresh;
}

/**
 * Deterministic JSON stringify so signing is stable across runs.
 * Keys sorted at every nesting level.
 */
function canonicalStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalStringify).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
	return `{${parts.join(",")}}`;
}

export interface SignedPayload<T = unknown> {
	payload: T;
	/** Hex-encoded HMAC-SHA256 of the canonical payload string */
	sig: string;
}

/**
 * Sign a payload object. The signature is over the canonical JSON
 * representation so equivalent payloads sign identically.
 *
 * Caller is responsible for writing the returned `{ payload, sig }` to
 * disk verbatim. On resume, pass the same object back to `verify`.
 */
export function sign<T>(payload: T, keyOverride?: Buffer): SignedPayload<T> {
	const key = keyOverride ?? loadOrCreateKey();
	const canonical = canonicalStringify(payload);
	const sig = crypto.createHmac("sha256", key).update(canonical, "utf-8").digest("hex");
	return { payload, sig };
}

/**
 * Verify a signed payload. Constant-time comparison. Returns false on
 * any mismatch, malformed input, or missing key. Never throws on bad
 * sig - callers should treat false as "refuse to resume".
 */
export function verify(signed: SignedPayload, keyOverride?: Buffer): boolean {
	if (
		!signed ||
		typeof signed !== "object" ||
		typeof signed.sig !== "string" ||
		!("payload" in signed)
	) {
		return false;
	}

	let key: Buffer;
	try {
		key = keyOverride ?? loadOrCreateKey();
	} catch {
		return false;
	}

	const canonical = canonicalStringify(signed.payload);
	const expected = crypto.createHmac("sha256", key).update(canonical, "utf-8").digest();

	let provided: Buffer;
	try {
		provided = Buffer.from(signed.sig, "hex");
	} catch {
		return false;
	}

	if (provided.length !== expected.length) return false;
	return crypto.timingSafeEqual(provided, expected);
}

/**
 * Verify and throw on mismatch. Use this from resume paths where the
 * intent is to abort the entire /goal run on bad state.
 */
export function verifyOrThrow(signed: SignedPayload, keyOverride?: Buffer): void {
	if (!verify(signed, keyOverride)) {
		throw new Error(
			"[goal-state-hmac] State signature mismatch. Refusing to resume - .go-state.json may have been tampered with.",
		);
	}
}
