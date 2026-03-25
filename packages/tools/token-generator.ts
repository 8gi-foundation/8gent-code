/**
 * token-generator.ts
 * Crypto-safe token, API key, session ID, OTP, and secret generation.
 * All entropy sourced from crypto.getRandomValues — no Math.random.
 */

// ---------------------------------------------------------------------------
// Character sets
// ---------------------------------------------------------------------------

const CHARSET_ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const CHARSET_HEX = "0123456789abcdef";

const CHARSET_URL_SAFE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const CHARSET_NUMERIC = "0123456789";

// ---------------------------------------------------------------------------
// Core random helpers
// ---------------------------------------------------------------------------

/**
 * Returns a Uint8Array of cryptographically random bytes.
 */
function randomBytes(count: number): Uint8Array {
  const buf = new Uint8Array(count);
  crypto.getRandomValues(buf);
  return buf;
}

/**
 * Picks `length` characters from `charset` using rejection sampling so every
 * character has equal probability (no modulo bias).
 */
function pickFromCharset(charset: string, length: number): string {
  const chars = charset.split("");
  const max = 256 - (256 % chars.length); // rejection threshold
  let result = "";

  while (result.length < length) {
    const needed = length - result.length;
    // Over-sample to reduce round-trips; 1.5x is a good heuristic.
    const raw = randomBytes(Math.ceil(needed * 1.5));
    for (const byte of raw) {
      if (result.length === length) break;
      if (byte < max) {
        result += chars[byte % chars.length];
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a random token from a charset.
 *
 * @param length  Number of characters. Default 32.
 * @param charset Character set to sample from. Default: URL-safe alphanumeric.
 */
export function generateToken(
  length = 32,
  charset: string = CHARSET_URL_SAFE
): string {
  if (length < 1) throw new RangeError("length must be >= 1");
  if (charset.length < 2) throw new RangeError("charset must have >= 2 chars");
  return pickFromCharset(charset, length);
}

/**
 * Generates an API key with an optional vendor prefix.
 * Format: `<prefix>_<48-char alphanumeric>`
 *
 * @param prefix  Short string prepended before underscore. Default "sk".
 */
export function generateApiKey(prefix = "sk"): string {
  const body = pickFromCharset(CHARSET_ALPHANUMERIC, 48);
  return prefix ? `${prefix}_${body}` : body;
}

/**
 * Generates a URL-safe session ID.
 * Format: 40-char URL-safe base64-like string (no padding).
 */
export function generateSessionId(): string {
  return pickFromCharset(CHARSET_URL_SAFE, 40);
}

/**
 * Generates a numeric one-time password (OTP).
 *
 * @param digits  Number of digits. Default 6.
 */
export function generateOTP(digits = 6): string {
  if (digits < 1 || digits > 10) {
    throw new RangeError("digits must be between 1 and 10");
  }
  return pickFromCharset(CHARSET_NUMERIC, digits);
}

/**
 * Generates a random secret as a lowercase hex string.
 *
 * @param bytes  Number of random bytes. Default 32 (256-bit).
 */
export function generateSecret(bytes = 32): string {
  if (bytes < 1) throw new RangeError("bytes must be >= 1");
  const raw = randomBytes(bytes);
  return Array.from(raw)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Named exports (re-export charsets for callers that want custom sets)
// ---------------------------------------------------------------------------

export { CHARSET_ALPHANUMERIC, CHARSET_HEX, CHARSET_URL_SAFE, CHARSET_NUMERIC };
