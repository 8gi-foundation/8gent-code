/**
 * 8gent Code - /goal State HMAC (issue #2609, epic #2605)
 *
 * Signs `.go-state.json` so a resumed /goal run cannot be tampered with
 * between sessions. Uses a daemon-resident HMAC key at
 * `~/.8gent/keys/state-hmac.key`. The key is generated on first use,
 * 32 bytes, chmod 0600. Verify mismatch => refuse to resume.
 *
 * Owner: 8SO.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where the HMAC key lives on disk. */
export function getKeyPath(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return path.join(base, "keys", "state-hmac.key");
}

/** Key length in bytes. 32 = 256 bits, matches HMAC-SHA256 block. */
const KEY_BYTES = 32;

/**
 * Load the HMAC key from disk. Generates one on first use with 0600
 * perms. Throws if the key file exists but has the wrong size or
 * cannot be read.
 */
export function loadOrCreateKey(): Buffer {
	const keyPath = getKeyPath();
	const dir = path.dirname(keyPath);

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	if (fs.existsSync(keyPath)) {
		const raw = fs.readFileSync(keyPath);
		if (raw.length !== KEY_BYTES) {
			throw new Error(
				`[goal-state-hmac] Existing key at ${keyPath} has wrong length (${raw.length} bytes, expected ${KEY_BYTES}). Refusing to use.`,
			);
		}
		return raw;
	}

	// Generate fresh key. Use writeFileSync with mode option AND chmod
	// to defend against umask on platforms that ignore mode at create time.
	const fresh = crypto.randomBytes(KEY_BYTES);
	fs.writeFileSync(keyPath, fresh, { mode: 0o600 });
	try {
		fs.chmodSync(keyPath, 0o600);
	} catch {
		// chmod on Windows is best-effort; key file still exists.
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
