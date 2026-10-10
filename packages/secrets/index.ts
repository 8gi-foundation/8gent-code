/**
 * 8gent Code - Secrets Management
 *
 * Encrypted vault for API keys and sensitive values.
 * Uses AES-256-GCM with a machine-derived key (hostname + username).
 * The vault file lives at ~/.8gent/vault.enc and is tied to the machine.
 *
 * LLM isolation: raw secret values are NEVER returned to the model.
 * Use `useSecret()` to pass values into callbacks without exposure.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================
// Types
// ============================================

interface VaultEntry {
	/** AES-256-GCM initialization vector (hex) */
	iv: string;
	/** AES-256-GCM auth tag (hex) */
	tag: string;
	/** Encrypted value (hex) */
	ciphertext: string;
}

interface VaultData {
	version: 1;
	entries: Record<string, VaultEntry>;
}

// ============================================
// Key Derivation
// ============================================

/**
 * Derives a 256-bit encryption key from machine-specific fingerprint.
 * Uses PBKDF2 with hostname + username as the base material and a
 * fixed salt so the same machine always produces the same key.
 */
function deriveKey(): Buffer {
	const fingerprint = `${os.hostname()}:${os.userInfo().username}`;
	const salt = "8gent-vault-v1"; // static salt — key is machine-bound
	return crypto.pbkdf2Sync(fingerprint, salt, 100_000, 32, "sha256");
}

/** The vault file exists but could not be read. Carries no vault contents. */
export class VaultUnreadableError extends Error {
	constructor(
		readonly vaultPath: string,
		readonly copyPath: string | null,
	) {
		super(
			copyPath
				? `The vault file could not be read. It was left unchanged and a copy kept at ${copyPath}.`
				: "The vault file could not be read. It was left unchanged.",
		);
		this.name = "VaultUnreadableError";
	}
}

// ============================================
// SecretVault
// ============================================

export class SecretVault {
	private vaultPath: string;
	private key: Buffer;
	private data: VaultData;

	constructor(vaultPath?: string) {
		this.vaultPath = vaultPath ?? path.join(os.homedir(), ".8gent", "vault.enc");
		this.key = deriveKey();
		this.data = this.load();
	}

	// ---------- Core CRUD ----------

	/** Encrypt and store a secret. Overwrites if key exists. */
	set(key: string, value: string): void {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);

		let ciphertext = cipher.update(value, "utf8", "hex");
		ciphertext += cipher.final("hex");
		const tag = cipher.getAuthTag();

		this.data.entries[key] = {
			iv: iv.toString("hex"),
			tag: tag.toString("hex"),
			ciphertext,
		};

		this.save();
	}

	/** Decrypt and return a secret value, or undefined if missing. */
	get(key: string): string | undefined {
		const entry = this.data.entries[key];
		if (!entry) return undefined;

		try {
			const decipher = crypto.createDecipheriv(
				"aes-256-gcm",
				this.key,
				Buffer.from(entry.iv, "hex"),
			);
			decipher.setAuthTag(Buffer.from(entry.tag, "hex"));

			let plaintext = decipher.update(entry.ciphertext, "hex", "utf8");
			plaintext += decipher.final("utf8");
			return plaintext;
		} catch {
			return undefined; // corrupted or wrong machine
		}
	}

	/** Return all stored key names. Never returns values. */
	list(): string[] {
		return Object.keys(this.data.entries).sort();
	}

	/** Remove a secret by key. Returns true if it existed. */
	delete(key: string): boolean {
		if (!(key in this.data.entries)) return false;
		delete this.data.entries[key];
		this.save();
		return true;
	}

	/** Check whether a key exists in the vault. */
	has(key: string): boolean {
		return key in this.data.entries;
	}

	// ---------- LLM Isolation ----------

	/**
	 * Use a secret without exposing it to the LLM.
	 *
	 * The raw value is passed into the callback but never returned
	 * to the caller as a string — only the callback's result is returned.
	 * This lets tools make authenticated API calls without leaking keys.
	 *
	 * @example
	 * const result = await vault.useSecret("OPENROUTER_KEY", async (apiKey) => {
	 *   const res = await fetch("https://api.openrouter.ai/...", {
	 *     headers: { Authorization: `Bearer ${apiKey}` },
	 *   });
	 *   return res.statusText; // only this goes back to the model
	 * });
	 */
	async useSecret(key: string, callback: (value: string) => Promise<string>): Promise<string> {
		const value = this.get(key);
		if (value === undefined) {
			throw new Error(`Secret "${key}" not found in vault`);
		}
		return callback(value);
	}

	// ---------- Migration ----------

	/**
	 * Import all KEY=VALUE pairs from a .env file into the vault.
	 * Skips comments and blank lines. Returns the count of imported keys.
	 */
	migrateFromEnv(envPath: string): { imported: string[]; skipped: string[] } {
		if (!fs.existsSync(envPath)) {
			throw new Error(`File not found: ${envPath}`);
		}

		const content = fs.readFileSync(envPath, "utf-8");
		const imported: string[] = [];
		const skipped: string[] = [];

		for (const line of content.split("\n")) {
			const trimmed = line.trim();

			// Skip empty lines and comments
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			let value = trimmed.slice(eqIndex + 1).trim();

			// Strip surrounding quotes
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			if (!key) continue;

			if (this.has(key)) {
				skipped.push(key);
			} else {
				this.set(key, value);
				imported.push(key);
			}
		}

		return { imported, skipped };
	}

	// ---------- Persistence ----------

	/**
	 * Read the vault file. A missing or blank file is an empty vault. A file that
	 * cannot be read or understood is NEVER treated as empty: the next save()
	 * would overwrite whatever it held. Instead a private copy is kept beside it
	 * and a VaultUnreadableError is thrown, so the caller fails loudly.
	 */
	private load(): VaultData {
		if (!fs.existsSync(this.vaultPath)) {
			return { version: 1, entries: {} };
		}

		let raw: string;
		try {
			raw = fs.readFileSync(this.vaultPath, "utf-8");
		} catch {
			throw new VaultUnreadableError(this.vaultPath, null);
		}
		if (raw.trim() === "") return { version: 1, entries: {} };

		try {
			const parsed = JSON.parse(raw) as VaultData;
			const entries = parsed?.entries;
			if (
				parsed?.version !== 1 ||
				!entries ||
				typeof entries !== "object" ||
				Array.isArray(entries)
			) {
				throw new Error("unsupported vault shape");
			}
			return parsed;
		} catch {
			throw new VaultUnreadableError(this.vaultPath, this.keepCopy(raw));
		}
	}

	/** Preserve an unreadable vault file (owner-only). Returns the copy's path. */
	private keepCopy(raw: string): string | null {
		const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
		const copy = `${this.vaultPath}.unreadable-${digest}`;
		try {
			fs.writeFileSync(copy, raw, { mode: 0o600, flag: "wx" });
		} catch (err) {
			// An identical copy from an earlier run is fine; anything else means
			// we have no backup, which the error message says.
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
		}
		return copy;
	}

	private save(): void {
		const dir = path.dirname(this.vaultPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		// Write a new owner-only file and rename it into place: the vault is never
		// readable by others at any moment, and a crash cannot leave it half written.
		const tmp = `${this.vaultPath}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
		fs.chmodSync(tmp, 0o600);
		fs.renameSync(tmp, this.vaultPath);
	}
}

// ============================================
// Singleton
// ============================================

let _vault: SecretVault | null = null;

/** Like getVault(), but null when the vault file is unreadable (callers that can run without it). */
export function getVaultOrNull(): SecretVault | null {
	try {
		return getVault();
	} catch {
		return null;
	}
}

export function getVault(): SecretVault {
	if (!_vault) {
		_vault = new SecretVault();
	}
	return _vault;
}

export { KeychainVault, getKeychainVault } from "./keychain";
export type { KeychainVaultOptions } from "./keychain";
export { LibsecretVault, getLibsecretVault, getOSVault } from "./libsecret";
export type { LibsecretVaultOptions } from "./libsecret";

// Lightweight ~/.8gent/keys.env path (file-backed, user-editable, no
// encryption). Complements the encrypted SecretVault above for users
// who'd rather edit a plain .env file in their editor of choice.
export {
	KEYS_DIR,
	KEYS_PATH,
	ensureKeysFile,
	loadKeysIntoEnv,
	openKeysFile,
	readKeysFile,
	redactAndWarn,
	redactKeys,
} from "./keys";
export type { RedactResult } from "./keys";
