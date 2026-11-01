/**
 * Encrypted-at-rest storage for Telegram memory (C-M10, epic #4391).
 *
 * bun:sqlite has no SQLCipher, so the database never touches disk as SQLite. It lives in an
 * in-memory Database; after each change it is serialized, sealed with AES-256-GCM and written
 * atomically to <dir>/memory.db.enc (dir 0700, file 0600). The 32-byte key lives in the macOS
 * Keychain, never beside the data. No key, a wrong key or a tampered file all fail closed: the
 * vault does not open and an undecryptable file is never overwritten.
 *
 * No embedding provider is wired in, so recall is FTS only and no stored text can leave the host.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MemoryStore } from "./store.js";
import { ensurePrivateDir } from "./telegram-memory-audit.js";

const MAGIC = Buffer.from("8GMV1");
const KEYCHAIN_SERVICE = "8gent-telegram-memory";
const KEYCHAIN_ACCOUNT = "memory-db-key";

export type KeyProvider = () => Buffer | null;

/** Read the key from the macOS Keychain, creating it on first use. Null (fail closed) on any problem. */
export const keychainKey: KeyProvider = () => {
	if (process.platform !== "darwin") return null;
	try {
		const get = spawnSync("security", [
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			KEYCHAIN_ACCOUNT,
			"-w",
		]);
		if (get.status === 0) {
			const key = Buffer.from(get.stdout.toString().trim(), "hex");
			return key.length === 32 ? key : null;
		}
		// Not found: provision once. The key is briefly an argument of `security`; the residual is
		// documented in docs/telegram-bridge-memory.md. A failure here leaves memory off.
		const fresh = randomBytes(32);
		const add = spawnSync("security", [
			"add-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			KEYCHAIN_ACCOUNT,
			"-w",
			fresh.toString("hex"),
		]);
		return add.status === 0 ? fresh : null;
	} catch {
		return null;
	}
};

export function seal(plain: Uint8Array, key: Buffer): Buffer {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	c.setAAD(MAGIC);
	const ct = Buffer.concat([c.update(plain), c.final()]);
	return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

export function unseal(blob: Buffer, key: Buffer): Buffer {
	if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
		throw new Error("vault: not a sealed memory file");
	}
	const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
	const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
	const d = createDecipheriv("aes-256-gcm", key, iv);
	d.setAAD(MAGIC);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(blob.subarray(MAGIC.length + 28)), d.final()]);
}

export class MemoryVault {
	readonly file: string;

	private constructor(
		dir: string,
		readonly store: MemoryStore,
		private key: Buffer,
	) {
		this.file = join(dir, "memory.db.enc");
	}

	/** Open or create. Throws (fail closed) with no key, a wrong key or a damaged file. */
	static open(dir: string, keyProvider: KeyProvider = keychainKey): MemoryVault {
		const key = keyProvider();
		if (!key || key.length !== 32) throw new Error("vault: no encryption key available");
		ensurePrivateDir(dir);
		const file = join(dir, "memory.db.enc");
		const db = existsSync(file)
			? Database.deserialize(unseal(readFileSync(file), key))
			: new Database(":memory:");
		db.exec("PRAGMA secure_delete = ON");
		const vault = new MemoryVault(dir, new MemoryStore(db), key);
		vault.persist();
		return vault;
	}

	/**
	 * Serialize, seal and replace the file atomically. Only ciphertext reaches disk.
	 *
	 * Vault operations (open, write, purge, persist) must stay synchronous: there is one in-memory
	 * database and one file, and no lock. An `await` between a read and the write that follows it
	 * would let another message interleave and seal a stale image over a newer one.
	 */
	persist(): void {
		const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		const sealed = seal(this.store.db.serialize(), this.key);
		try {
			const fd = openSync(tmp, "w", 0o600);
			try {
				writeSync(fd, sealed);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			chmodSync(tmp, 0o600);
			renameSync(tmp, this.file);
			// Make the rename itself durable.
			const dfd = openSync(dirname(this.file), "r");
			try {
				fsyncSync(dfd);
			} finally {
				closeSync(dfd);
			}
		} catch (err) {
			try {
				unlinkSync(tmp);
			} catch {
				// already renamed or never created
			}
			throw err;
		}
	}

	/** Plaintext image of the database, for tests that prove a purge removed the text. */
	plainImage(): Uint8Array {
		return this.store.db.serialize();
	}
}
