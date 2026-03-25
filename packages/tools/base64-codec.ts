/**
 * base64-codec - Standard and URL-safe base64 encode/decode utility.
 *
 * Exports:
 *   encode(input)          - standard base64 encode (string or Buffer)
 *   decode(input)          - standard base64 decode to string
 *   decodeToBuffer(input)  - standard base64 decode to raw Buffer
 *   encodeUrlSafe(input)   - URL-safe base64 (no +/=, uses -_)
 *   decodeUrlSafe(input)   - URL-safe base64 decode to string
 *   isBase64(input)        - validate standard base64 string
 *   isBase64UrlSafe(input) - validate URL-safe base64 string
 *   streamEncoder(data, options) - streaming encode for large data
 */

export type Base64Input = string | Buffer | Uint8Array;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBuffer(input: Base64Input): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return Buffer.from(input, "utf8");
}

// ---------------------------------------------------------------------------
// Standard base64
// ---------------------------------------------------------------------------

/**
 * Encode a string, Buffer, or Uint8Array to standard base64.
 */
export function encode(input: Base64Input): string {
  return toBuffer(input).toString("base64");
}

/**
 * Decode a standard base64 string back to a UTF-8 string.
 * Throws if the input is not valid base64.
 */
export function decode(input: string): string {
  if (!isBase64(input)) {
    throw new Error(`Invalid base64 string: "${input.slice(0, 40)}..."`);
  }
  return Buffer.from(input, "base64").toString("utf8");
}

/**
 * Decode a standard base64 string to a raw Buffer (no UTF-8 conversion).
 */
export function decodeToBuffer(input: string): Buffer {
  if (!isBase64(input)) {
    throw new Error(`Invalid base64 string: "${input.slice(0, 40)}..."`);
  }
  return Buffer.from(input, "base64");
}

// ---------------------------------------------------------------------------
// URL-safe base64  (RFC 4648 section 5 - replaces +/= with -_)
// ---------------------------------------------------------------------------

/**
 * Encode to URL-safe base64. Replaces + with -, / with _, strips padding =.
 */
export function encodeUrlSafe(input: Base64Input): string {
  return toBuffer(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode a URL-safe base64 string back to a UTF-8 string.
 */
export function decodeUrlSafe(input: string): string {
  if (!isBase64UrlSafe(input)) {
    throw new Error(`Invalid URL-safe base64 string: "${input.slice(0, 40)}..."`);
  }
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const standard = pad ? padded + "=".repeat(4 - pad) : padded;
  return Buffer.from(standard, "base64").toString("utf8");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_URL_RE = /^[A-Za-z0-9\-_]*$/;

/**
 * Return true if the input is a valid standard base64 string (including padding).
 */
export function isBase64(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  return BASE64_RE.test(input);
}

/**
 * Return true if the input is a valid URL-safe base64 string (no padding required).
 */
export function isBase64UrlSafe(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  return BASE64_URL_RE.test(input);
}

// ---------------------------------------------------------------------------
// Streaming encoder for large data
// ---------------------------------------------------------------------------

export interface StreamEncoderOptions {
  /** Byte chunk size to feed to the encoder at a time. Default: 3072 (exact multiple of 3). */
  chunkSize?: number;
  /** Called with each base64 chunk as it is produced. */
  onChunk: (chunk: string) => void;
  /** Called when encoding is complete. */
  onEnd?: () => void;
}

/**
 * Stream-encode a large Buffer in chunks. Each emitted chunk is a valid
 * base64 fragment. Concatenating all chunks yields the full base64 string.
 *
 * chunkSize MUST be a multiple of 3 to avoid mid-stream padding artefacts.
 */
export function streamEncoder(data: Base64Input, options: StreamEncoderOptions): void {
  const buf = toBuffer(data);
  const chunkSize = options.chunkSize ?? 3072;

  if (chunkSize % 3 !== 0) {
    throw new Error("chunkSize must be a multiple of 3 to avoid base64 padding artefacts");
  }

  let offset = 0;
  while (offset < buf.length) {
    const slice = buf.subarray(offset, offset + chunkSize);
    options.onChunk(slice.toString("base64"));
    offset += chunkSize;
  }

  options.onEnd?.();
}
