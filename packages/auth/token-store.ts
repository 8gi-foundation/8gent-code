/**
 * @8gent/auth — Secure Token Storage
 *
 * Two implementations:
 * 1. KeychainTokenStore — macOS Keychain via `security` CLI (primary)
 * 2. EncryptedFileTokenStore — AES-256-GCM encrypted file (fallback for Linux/CI)
 *
 * The same pattern as packages/secrets/ but specialized for auth tokens.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { TokenStore, StoredToken } from "./types.js";

// ============================================
// Platform Detection
// ============================================

/**
 * Get the appropriate token store for the current platform.
 * macOS gets Keychain, everything else gets encrypted file.
 */
export function getTokenStore(): TokenStore {
  if (process.platform === "darwin") {
    return new KeychainTokenStore();
  }
  return new EncryptedFileTokenStore();
}

// ============================================
// macOS Keychain Token Store
// ============================================

const KEYCHAIN_SERVICE = "8gent-auth";
const KEYCHAIN_ACCOUNT = "8gent-cli";

/**
 * Stores auth tokens in the macOS Keychain using the `security` CLI.
 *
 * This is the standard approach used by `gh`, `npm`, `docker`, and
 * other CLI tools on macOS. Tokens are encrypted at the OS level
 * and protected by the user's login keychain.
 */
export class KeychainTokenStore implements TokenStore {
  async store(token: StoredToken): Promise<void> {
    const value = JSON.stringify(token);

    // Delete existing entry first (add-generic-password fails if exists without -U)
    await this.runSecurity([
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
    ]).catch(() => {
      /* ignore — may not exist */
    });

    // Store the new token
    const result = await this.runSecurity([
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
      value,
      "-U", // Update if exists (belt and suspenders)
    ]);

    if (!result.success) {
      throw new Error(`Failed to store token in Keychain: ${result.stderr}`);
    }
  }

  async retrieve(): Promise<StoredToken | null> {
    const result = await this.runSecurity([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w", // Output password only
    ]);

    if (!result.success || !result.stdout.trim()) {
      return null;
    }

    try {
      return JSON.parse(result.stdout.trim()) as StoredToken;
    } catch {
      // Corrupted entry — clear it
      await this.clear();
      return null;
    }
  }

  async clear(): Promise<void> {
    await this.runSecurity([
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
    ]).catch(() => {
      /* ignore — may not exist */
    });
  }

  async exists(): Promise<boolean> {
    const result = await this.runSecurity([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
    ]);
    return result.success;
  }

  /**
   * Run a macOS `security` CLI command.
   * Returns { success, stdout, stderr }.
   */
  private async runSecurity(
    args: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    try {
      const proc = Bun.spawn(["security", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      const exitCode = await proc.exited;

      return {
        success: exitCode === 0,
        stdout,
        stderr,
      };
    } catch (error) {
      return {
        success: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// Encrypted File Token Store (Fallback)
// ============================================

const TOKEN_FILE_NAME = "auth-token.enc";
const KEY_DERIVATION_SALT = "8gent-auth-v1";

/**
 * Stores auth tokens in an AES-256-GCM encrypted file.
 * Uses the same machine-derived key pattern as packages/secrets/.
 *
 * File location: ~/.8gent/auth-token.enc
 * Permissions: 0o600 (owner read/write only)
 */
export class EncryptedFileTokenStore implements TokenStore {
  private filePath: string;
  private key: Buffer;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? path.join(os.homedir(), ".8gent", TOKEN_FILE_NAME);
    this.key = this.deriveKey();
  }

  async store(token: StoredToken): Promise<void> {
    const plaintext = JSON.stringify(token);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);

    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag();

    const envelope = {
      version: 1,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      ciphertext,
    };

    // Ensure directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.filePath, JSON.stringify(envelope), {
      mode: 0o600,
    });
  }

  async retrieve(): Promise<StoredToken | null> {
    if (!fs.existsSync(this.filePath)) return null;

    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const envelope = JSON.parse(raw);

      if (envelope.version !== 1) return null;

      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(envelope.iv, "hex"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));

      let plaintext = decipher.update(envelope.ciphertext, "hex", "utf8");
      plaintext += decipher.final("utf8");

      return JSON.parse(plaintext) as StoredToken;
    } catch {
      // Corrupted file or wrong machine — clear it
      await this.clear();
      return null;
    }
  }

  async clear(): Promise<void> {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }

  async exists(): Promise<boolean> {
    return fs.existsSync(this.filePath);
  }

  /**
   * Derive encryption key from machine fingerprint.
   * Same approach as packages/secrets/ — PBKDF2 with hostname:username.
   */
  private deriveKey(): Buffer {
    const fingerprint = `${os.hostname()}:${os.userInfo().username}`;
    return crypto.pbkdf2Sync(
      fingerprint,
      KEY_DERIVATION_SALT,
      100_000,
      32,
      "sha256",
    );
  }
}
