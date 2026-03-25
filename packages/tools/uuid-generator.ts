/**
 * UUID Generator - zero-dependency UUID v4, v7, nano ID, and validation
 * Supports: v4 (random), v7 (time-sortable), nano IDs, UUID validation,
 * and timestamp extraction from v7 UUIDs.
 */

const HEX = "0123456789abcdef";

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => HEX[b >> 4] + HEX[b & 0xf])
    .join("");
}

/**
 * Generate a UUID v4 (randomly generated).
 * Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function uuidv4(): string {
  const bytes = randomBytes(16);
  // Set version 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant bits (10xx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytesToHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Generate a UUID v7 (Unix timestamp + random, time-sortable).
 * First 48 bits = Unix ms timestamp. Version = 7.
 * Format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());

  // Embed 48-bit Unix timestamp in bytes 0-5
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);

  // Set version 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Set variant bits (10xx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytesToHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Generate a URL-safe nano ID of configurable length (default 21).
 * Uses [A-Za-z0-9_-] alphabet (64 chars).
 */
export function nanoid(length = 21): string {
  const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const bytes = randomBytes(length);
  return Array.from(bytes)
    .map((b) => ALPHABET[b & 63])
    .join("");
}

/**
 * Validate whether a string is a well-formed UUID (v1-v7 or nil).
 * Checks format only - does not validate version-specific bit fields.
 */
export function isUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str
  );
}

/**
 * Extract the Unix timestamp (ms) from a UUID v7.
 * Returns null if the input is not a valid v7 UUID.
 */
export function extractTimestampV7(uuid: string): number | null {
  if (!isUUID(uuid)) return null;
  const version = parseInt(uuid[14], 16);
  if (version !== 7) return null;

  // First 12 hex chars (48 bits) encode the timestamp
  const hex = uuid.replace(/-/g, "").slice(0, 12);
  return parseInt(hex, 16);
}

/**
 * Convenience: generate multiple UUIDs at once.
 */
export function batchUUID(
  count: number,
  type: "v4" | "v7" = "v4"
): string[] {
  const gen = type === "v7" ? uuidv7 : uuidv4;
  return Array.from({ length: count }, gen);
}
