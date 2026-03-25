/**
 * uid-generator.ts
 * Multi-format ID generator for 8gent. All outputs are collision-resistant.
 */

import { createHash } from "crypto";

// Monotonic counter for sequential IDs - process-scoped, reset on restart
let _seq = 0;

const BASE62_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Returns `len` cryptographically random bytes as a Uint8Array. */
function randomBytes(len: number): Uint8Array {
  // Bun/Node both expose crypto.getRandomValues via globalThis
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

/**
 * Encodes bytes into a base-62 string of exactly `outputLen` characters.
 * Reads bytes modulo 62 - good enough for IDs (slight bias < 0.7%).
 */
function base62Encode(bytes: Uint8Array, outputLen: number): string {
  let result = "";
  for (let i = 0; i < outputLen; i++) {
    result += BASE62_CHARS[bytes[i % bytes.length] % 62];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Short alphanumeric ID (base-62). Default length 8, minimum 4.
 * @example shortId()       => "aB3xZ9Kp"
 * @example shortId(12)     => "mN7qLp2RtJ4s"
 */
export function shortId(len = 8): string {
  if (len < 4) throw new RangeError("shortId: len must be >= 4");
  return base62Encode(randomBytes(len * 2), len);
}

/**
 * Prefixed ID - "<prefix>_<shortId>". Useful for typed entities.
 * @example prefixedId("usr")  => "usr_aB3xZ9Kp"
 * @example prefixedId("task") => "task_mN7qLp2R"
 */
export function prefixedId(prefix: string, len = 8): string {
  if (!prefix || /[^a-zA-Z0-9]/.test(prefix)) {
    throw new TypeError(
      "prefixedId: prefix must be non-empty alphanumeric string"
    );
  }
  return `${prefix}_${shortId(len)}`;
}

/**
 * Timestamp-based sortable ID: "<ms-epoch>-<random-suffix>".
 * Lexicographically sortable by creation time.
 * @example timestampId()  => "01af3c2b9d8e-aB3xZ9"
 */
export function timestampId(randomSuffixLen = 6): string {
  const ts = Date.now().toString(16).padStart(12, "0");
  const suffix = randomHex(Math.ceil(randomSuffixLen / 2)).slice(
    0,
    randomSuffixLen
  );
  return `${ts}-${suffix}`;
}

/**
 * Sequential ID within this process lifetime: "<padded-counter>-<suffix>".
 * Guaranteed unique within a single process run. Not globally unique alone -
 * combine with prefixedId or timestampId for distributed use.
 * @example sequentialId()  => "000001-aB3x"
 */
export function sequentialId(suffixLen = 4): string {
  _seq += 1;
  const counter = String(_seq).padStart(6, "0");
  const suffix = shortId(suffixLen);
  return `${counter}-${suffix}`;
}

/**
 * Random hex string of exactly `len` hex characters (2 chars per byte).
 * @example randomHex(8)  => "a3f1bc09"
 */
export function randomHex(len = 16): string {
  const bytes = randomBytes(Math.ceil(len / 2));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

/**
 * URL-safe slug from arbitrary text. Lowercases, strips non-alphanumeric,
 * collapses hyphens. Appends a short random suffix to prevent collisions
 * between identical source strings.
 * @example slug("Hello World!")  => "hello-world-a3f1"
 */
export function slug(text: string, suffixLen = 4): string {
  if (!text) throw new TypeError("slug: text must be non-empty");
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const suffix = randomHex(suffixLen);
  return base ? `${base}-${suffix}` : suffix;
}

/**
 * Deterministic content-based hash ID (SHA-256, truncated to `len` hex chars).
 * Same content always produces the same ID. Safe for deduplication.
 * @example hashId("hello")        => "2cf24dba5f"  (len=10)
 * @example hashId("hello", 16)    => "2cf24dba5fb0a30e"
 */
export function hashId(content: string, len = 16): string {
  if (!content) throw new TypeError("hashId: content must be non-empty");
  if (len < 4 || len > 64) throw new RangeError("hashId: len must be 4-64");
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, len);
}
