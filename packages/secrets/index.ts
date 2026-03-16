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

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

// ============================================
// SecretVault
// ============================================

export class SecretVault {
  private vaultPath: string;
  private key: Buffer;
  private data: VaultData;

  constructor(vaultPath?: string) {
    this.vaultPath =
      vaultPath ?? path.join(os.homedir(), ".8gent", "vault.enc");
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
  async useSecret(
    key: string,
    callback: (value: string) => Promise<string>,
  ): Promise<string> {
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

  private load(): VaultData {
    if (!fs.existsSync(this.vaultPath)) {
      return { version: 1, entries: {} };
    }

    try {
      const raw = fs.readFileSync(this.vaultPath, "utf-8");
      const parsed = JSON.parse(raw) as VaultData;
      if (parsed.version !== 1) {
        throw new Error(`Unsupported vault version: ${parsed.version}`);
      }
      return parsed;
    } catch {
      // Corrupted vault — start fresh
      return { version: 1, entries: {} };
    }
  }

  private save(): void {
    const dir = path.dirname(this.vaultPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
      this.vaultPath,
      JSON.stringify(this.data, null, 2),
      { mode: 0o600 }, // owner read/write only
    );
  }
}

// ============================================
// Singleton
// ============================================

let _vault: SecretVault | null = null;

export function getVault(): SecretVault {
  if (!_vault) {
    _vault = new SecretVault();
  }
  return _vault;
}
