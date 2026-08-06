/**
 * 8gent Table - ed25519 per-participant identity (contract section 2).
 *
 * Library decision: Node/Bun built-in `node:crypto`. Bun ships ed25519 via
 * `generateKeyPairSync("ed25519")` + `sign(null, msg, key)` / `verify(...)`.
 * NO new dependency is added (@noble/ed25519 is deliberately NOT used).
 *
 * Keys are stored as PEM:
 *   private -> PKCS8, file `<base>.ed25519`      (0600)
 *   public  -> SPKI,  file `<base>.ed25519.pub`  (0644)
 *
 * File-base mapping from participant id:
 *   "human:<handle>" -> `<handle>`          -> `<handle>.ed25519`
 *   "agent:<id>"     -> `agent-<id>`        -> `agent-<id>.ed25519`
 *
 * Human keys are custodied silently on first post (the human never sees a
 * prompt). Agent keys are minted by the daemon at session bind. The identity
 * layer stacks with - and never replaces - the goal-ledger HMAC chain: the
 * ledger orders and tamper-evidences every act, ed25519 attributes each post
 * to its author for future non-repudiation and cross-node federation.
 */

import {
	createPrivateKey,
	createPublicKey,
	sign as edSign,
	verify as edVerify,
	generateKeyPairSync,
} from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Identity {
	participantId: ParticipantId;
	publicKeyPem: string;
}

export interface KeyDir {
	root: string;
}

import type { ParticipantId } from "./types.js";

/** Default key directory: ~/.8gent/table/keys (honors EIGHT_DATA_DIR). */
export function defaultKeyDir(): KeyDir {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	return { root: path.join(base, "table", "keys") };
}

/**
 * Map a prefixed participant id to its on-disk file base.
 * Throws TypeError on an unprefixed / malformed id so we never write a key
 * to an ambiguous path.
 */
export function fileBaseFor(participantId: ParticipantId): string {
	const colon = participantId.indexOf(":");
	if (colon <= 0) {
		throw new TypeError(
			`[table/identity] participant id must be namespaced ("human:<handle>" | "agent:<id>"): got "${participantId}"`,
		);
	}
	const ns = participantId.slice(0, colon);
	const rest = participantId.slice(colon + 1);
	if (!rest) {
		throw new TypeError(`[table/identity] empty identifier after namespace in "${participantId}"`);
	}
	// Guard against path traversal in the handle/id segment.
	if (/[/\\]|\.\./.test(rest)) {
		throw new TypeError(`[table/identity] illegal characters in participant id "${participantId}"`);
	}
	if (ns === "human") return rest;
	if (ns === "agent") return `agent-${rest}`;
	throw new TypeError(
		`[table/identity] unknown participant namespace "${ns}" in "${participantId}"`,
	);
}

function privPath(dir: KeyDir, participantId: ParticipantId): string {
	return path.join(dir.root, `${fileBaseFor(participantId)}.ed25519`);
}

function pubPath(dir: KeyDir, participantId: ParticipantId): string {
	return path.join(dir.root, `${fileBaseFor(participantId)}.ed25519.pub`);
}

function ensureDir(dir: KeyDir): void {
	if (!fs.existsSync(dir.root)) {
		fs.mkdirSync(dir.root, { recursive: true, mode: 0o700 });
	}
}

/**
 * Generate + persist a keypair for a participant. Idempotent: if a key
 * already exists on disk it is loaded and returned unchanged (we never
 * overwrite existing key material).
 */
export function mintIdentity(
	participantId: ParticipantId,
	dir: KeyDir = defaultKeyDir(),
): Identity {
	const existing = loadIdentity(participantId, dir);
	if (existing) return existing;

	ensureDir(dir);
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

	// Write private first with restrictive perms; chmod again to defeat umask.
	fs.writeFileSync(privPath(dir, participantId), privPem, { mode: 0o600 });
	try {
		fs.chmodSync(privPath(dir, participantId), 0o600);
	} catch {
		// best-effort on platforms that ignore chmod
	}
	fs.writeFileSync(pubPath(dir, participantId), pubPem, { mode: 0o644 });

	return { participantId, publicKeyPem: pubPem };
}

/** Load an identity's public key from disk, or null if never minted. */
export function loadIdentity(
	participantId: ParticipantId,
	dir: KeyDir = defaultKeyDir(),
): Identity | null {
	const pub = pubPath(dir, participantId);
	if (!fs.existsSync(pub)) return null;
	const publicKeyPem = fs.readFileSync(pub, "utf8");
	return { participantId, publicKeyPem };
}

/** Load an existing identity or mint a fresh one. */
export function ensureIdentity(
	participantId: ParticipantId,
	dir: KeyDir = defaultKeyDir(),
): Identity {
	return loadIdentity(participantId, dir) ?? mintIdentity(participantId, dir);
}

/**
 * Sign a message with the participant's private key. Mints the key lazily
 * if absent (custodied-on-first-use). Returns a base64 signature.
 */
export function signMessage(
	participantId: ParticipantId,
	message: string,
	dir: KeyDir = defaultKeyDir(),
): string {
	ensureIdentity(participantId, dir);
	const privPem = fs.readFileSync(privPath(dir, participantId), "utf8");
	const key = createPrivateKey(privPem);
	// ed25519 uses the null algorithm (no separate digest).
	const sig = edSign(null, Buffer.from(message, "utf8"), key);
	return sig.toString("base64");
}

/**
 * Verify a base64 signature against the participant's public key.
 * Returns false (never throws) on any missing key, malformed signature,
 * or mismatch.
 */
export function verifyMessage(
	participantId: ParticipantId,
	message: string,
	sigB64: string,
	dir: KeyDir = defaultKeyDir(),
): boolean {
	try {
		const identity = loadIdentity(participantId, dir);
		if (!identity) return false;
		const key = createPublicKey(identity.publicKeyPem);
		return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
	} catch {
		return false;
	}
}

/** Return a participant's public key PEM, or null if never minted. */
export function publicKeyOf(
	participantId: ParticipantId,
	dir: KeyDir = defaultKeyDir(),
): string | null {
	return loadIdentity(participantId, dir)?.publicKeyPem ?? null;
}
