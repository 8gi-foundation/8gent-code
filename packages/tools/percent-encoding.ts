/**
 * RFC 3986 Percent Encoding / Decoding
 *
 * Provides correct percent-encoding for each URL component type.
 * Each component (path, query, fragment) has different reserved character sets
 * per RFC 3986 sections 2.2, 3.3, 3.4, and 3.5.
 *
 * UTF-8 multi-byte characters are encoded as multiple percent-encoded bytes.
 */

// Unreserved chars per RFC 3986 section 2.3: ALPHA / DIGIT / "-" / "." / "_" / "~"
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Percent-encode a single character into one or more %XX sequences.
 * Uses UTF-8 byte encoding for non-ASCII characters.
 */
function encodeChar(char: string): string {
  const bytes = new TextEncoder().encode(char);
  return Array.from(bytes)
    .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
    .join("");
}

/**
 * Core encoder: encodes all characters except unreserved ones and those in allowedExtra.
 */
function encodeComponent(input: string, allowedExtra: string): string {
  return Array.from(input)
    .map((char) => {
      if (UNRESERVED.test(char)) return char;
      if (allowedExtra.includes(char)) return char;
      return encodeChar(char);
    })
    .join("");
}

/**
 * Encode a URL path segment (single segment, no slashes).
 *
 * Allowed unencoded per RFC 3986 section 3.3 pchar:
 * unreserved / pct-encoded / sub-delims / ":" / "@"
 * sub-delims = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
 *
 * "/" is NOT allowed - use encodePathSegment for slashes in paths.
 */
export function encodePathComponent(segment: string): string {
  const pcharExtra = "!$&'()*+,;=:@";
  return encodeComponent(segment, pcharExtra);
}

/**
 * Encode a full path string, preserving "/" separators between segments.
 */
export function encodePath(path: string): string {
  return path.split("/").map(encodePathComponent).join("/");
}

/**
 * Encode a query string key or value (single component, not the full query).
 *
 * Allowed unencoded per RFC 3986 section 3.4 query:
 * pchar / "/" / "?"
 * We also keep "=" and "&" encoded since they are delimiters inside query strings.
 */
export function encodeQueryComponent(input: string): string {
  // Allow pchar extras plus "/" and "?" but NOT "=" or "&" (those delimit key=value&key=value)
  const queryExtra = "!$'()*+,;:@/?";
  return encodeComponent(input, queryExtra);
}

/**
 * Encode a fragment identifier.
 *
 * Allowed unencoded per RFC 3986 section 3.5 fragment:
 * pchar / "/" / "?"
 */
export function encodeFragment(fragment: string): string {
  const fragmentExtra = "!$&'()*+,;=:@/?";
  return encodeComponent(fragment, fragmentExtra);
}

/**
 * Decode a percent-encoded string back to its original value.
 *
 * Handles UTF-8 multi-byte sequences (e.g. %E2%82%AC -> "€").
 * Invalid or incomplete percent sequences are left as-is.
 */
export function decodeComponent(input: string): string {
  // Collect contiguous percent-encoded bytes and decode as UTF-8.
  const result: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === "%" && i + 2 < input.length) {
      const bytes: number[] = [];
      while (i < input.length && input[i] === "%" && i + 2 < input.length) {
        const hex = input.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 3;
        } else {
          break;
        }
      }
      if (bytes.length > 0) {
        try {
          result.push(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)));
        } catch {
          // Invalid UTF-8 sequence - push raw percent-encoded bytes
          bytes.forEach((b) => result.push("%" + b.toString(16).toUpperCase().padStart(2, "0")));
        }
      }
    } else {
      result.push(input[i]);
      i++;
    }
  }
  return result.join("");
}

/**
 * Check whether a string is already percent-encoded (contains at least one %XX sequence).
 * Does NOT verify that the entire string is fully encoded - only detects presence.
 */
export function isEncoded(input: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(input);
}
