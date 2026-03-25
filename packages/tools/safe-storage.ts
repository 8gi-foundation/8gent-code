/**
 * SafeStorage - AES-256-GCM encrypted key-value file storage.
 * Use for sensitive config: API keys, tokens, credentials.
 *
 * Encryption: AES-256-GCM with PBKDF2 key derivation (SHA-256, 100k iterations).
 * Storage: Single encrypted JSON file on disk. Each value gets its own IV and auth tag.
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12;  // 96 bits recommended for GCM
const SALT_LEN = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha256";

interface EncryptedEntry {
  iv: string;
  tag: string;
  salt: string;
  data: string;
}

interface StorageFile {
  version: number;
  entries: Record<string, EncryptedEntry>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LEN, PBKDF2_DIGEST);
}

function encrypt(plaintext: string, passphrase: string): EncryptedEntry {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    salt: salt.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

function decrypt(entry: EncryptedEntry, passphrase: string): string {
  const salt = Buffer.from(entry.salt, "hex");
  const iv = Buffer.from(entry.iv, "hex");
  const tag = Buffer.from(entry.tag, "hex");
  const data = Buffer.from(entry.data, "hex");
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export class SafeStorage {
  private readonly filePath: string;
  private readonly passphrase: string;

  constructor(filePath: string, passphrase: string) {
    if (!filePath) throw new Error("filePath is required");
    if (!passphrase || passphrase.length < 8)
      throw new Error("passphrase must be at least 8 characters");
    this.filePath = filePath;
    this.passphrase = passphrase;
  }

  private load(): StorageFile {
    if (!existsSync(this.filePath)) return { version: 1, entries: {} };
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as StorageFile;
    } catch {
      throw new Error("SafeStorage: failed to read " + this.filePath);
    }
  }

  private save(store: StorageFile): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  /** Store an encrypted value under the given key. Overwrites if key exists. */
  set(key: string, value: string): void {
    if (!key) throw new Error("key is required");
    const store = this.load();
    store.entries[key] = encrypt(value, this.passphrase);
    this.save(store);
  }

  /**
   * Retrieve and decrypt a value by key.
   * Returns null if key does not exist.
   * Throws on decryption failure (wrong passphrase or tampered data).
   */
  get(key: string): string | null {
    if (!key) throw new Error("key is required");
    const store = this.load();
    const entry = store.entries[key];
    if (!entry) return null;
    try {
      return decrypt(entry, this.passphrase);
    } catch {
      throw new Error(
        `SafeStorage: decryption failed for key "${key}" - wrong passphrase or corrupted data`
      );
    }
  }

  /** Delete a key. No-op if the key does not exist. */
  delete(key: string): void {
    if (!key) throw new Error("key is required");
    const store = this.load();
    delete store.entries[key];
    this.save(store);
  }

  /** List all stored keys. Values are not decrypted. */
  list(): string[] {
    return Object.keys(this.load().entries);
  }
}
