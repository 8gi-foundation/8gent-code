/**
 * Credential Vault
 *
 * Reads credentials from environment variables and optional dotenv files.
 * Never exposes raw secret values to the sandbox. Instead, tool inputs
 * use sentinel values like `$VAULT{API_KEY}` which the vault replaces
 * at the sandbox boundary.
 *
 * Design: credentials are loaded once at startup and held in memory.
 * The vault is the only component that touches secrets. The harness
 * and sandbox never see credential values directly.
 *
 * Issue: #1403
 */

import * as fs from "fs";
import type { CredentialVault } from "./types";

/** Sentinel pattern: $VAULT{KEY_NAME} */
const VAULT_SENTINEL = /\$VAULT\{([^}]+)\}/g;

/** Parse a simple KEY=VALUE dotenv file (no interpolation, no multiline). */
function parseDotenv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const result: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Replace sentinel values in a string. */
function replaceSentinels(
  value: string,
  secrets: Map<string, string>,
): string {
  return value.replace(VAULT_SENTINEL, (match, key) => {
    const secret = secrets.get(key);
    if (secret === undefined) return match; // Leave unresolved sentinels as-is
    return secret;
  });
}

/** Recursively inject credentials into an object, replacing sentinel strings. */
function injectDeep(
  obj: Record<string, unknown>,
  secrets: Map<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = replaceSentinels(value, secrets);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = injectDeep(value as Record<string, unknown>, secrets);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "string"
          ? replaceSentinels(item, secrets)
          : item !== null && typeof item === "object"
            ? injectDeep(item as Record<string, unknown>, secrets)
            : item,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Create a credential vault.
 * @param envFiles Optional list of dotenv file paths to load.
 */
export function createVault(envFiles?: string[]): CredentialVault {
  const secrets = new Map<string, string>();

  // Load from environment variables first
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      secrets.set(key, value);
    }
  }

  // Layer dotenv files on top (later files override earlier ones)
  if (envFiles) {
    for (const file of envFiles) {
      const parsed = parseDotenv(file);
      for (const [key, value] of Object.entries(parsed)) {
        secrets.set(key, value);
      }
    }
  }

  return {
    get(key: string): string | undefined {
      return secrets.get(key);
    },

    has(key: string): boolean {
      return secrets.has(key);
    },

    keys(): string[] {
      return Array.from(secrets.keys()).sort();
    },

    inject(input: Record<string, unknown>): Record<string, unknown> {
      return injectDeep(input, secrets);
    },
  };
}
