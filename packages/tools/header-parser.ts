/**
 * HTTP Header Parser and Formatter
 *
 * Parses HTTP-style headers from raw strings, formats them back to string,
 * and provides case-insensitive access, mutation, and merge utilities.
 */

/**
 * Parses a raw HTTP-style header string into a Map.
 * Each line must be in the format: "Name: Value"
 * Lines that don't match are silently skipped.
 * Duplicate header names are overwritten (last one wins).
 *
 * @example
 * const headers = parseHeaders("Content-Type: application/json\r\nX-Request-Id: abc123");
 * headers.get("content-type"); // "application/json"
 */
export function parseHeaders(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || raw.trim().length === 0) return map;

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (name.length === 0) continue;

    // Store with lowercase key for case-insensitive access
    map.set(name.toLowerCase(), value);
  }

  return map;
}

/**
 * Formats a header Map back into a raw HTTP-style header string.
 * Keys are title-cased (e.g. "content-type" -> "Content-Type").
 * Each header is separated by CRLF per HTTP spec.
 *
 * @example
 * formatHeaders(new Map([["content-type", "application/json"]]));
 * // "Content-Type: application/json"
 */
export function formatHeaders(headers: Map<string, string>): string {
  const lines: string[] = [];
  for (const [name, value] of headers) {
    lines.push(`${titleCase(name)}: ${value}`);
  }
  return lines.join("\r\n");
}

/**
 * Gets a header value by name, case-insensitively.
 * Returns null if the header is not present.
 *
 * @example
 * getHeader(headers, "Content-Type"); // same as getHeader(headers, "content-type")
 */
export function getHeader(
  headers: Map<string, string>,
  name: string
): string | null {
  return headers.get(name.toLowerCase()) ?? null;
}

/**
 * Sets a header value by name. The key is normalized to lowercase internally.
 * Overwrites any existing header with the same name (case-insensitive).
 *
 * @example
 * setHeader(headers, "Content-Type", "text/plain");
 */
export function setHeader(
  headers: Map<string, string>,
  name: string,
  value: string
): void {
  headers.set(name.toLowerCase(), value);
}

/**
 * Removes a header by name, case-insensitively.
 * No-op if the header does not exist.
 */
export function deleteHeader(
  headers: Map<string, string>,
  name: string
): void {
  headers.delete(name.toLowerCase());
}

/**
 * Merges two header maps. Headers from map b overwrite headers from map a
 * when they share the same name (case-insensitive).
 * Returns a new Map - neither input is mutated.
 *
 * @example
 * const merged = mergeHeaders(defaults, overrides);
 */
export function mergeHeaders(
  a: Map<string, string>,
  b: Map<string, string>
): Map<string, string> {
  const result = new Map<string, string>(a);
  for (const [name, value] of b) {
    result.set(name.toLowerCase(), value);
  }
  return result;
}

/**
 * Returns true if the header exists in the map, case-insensitively.
 */
export function hasHeader(
  headers: Map<string, string>,
  name: string
): boolean {
  return headers.has(name.toLowerCase());
}

// --- Internal helpers ---

/**
 * Title-cases a hyphen-separated header name.
 * "content-type" -> "Content-Type"
 * "x-request-id" -> "X-Request-Id"
 */
function titleCase(name: string): string {
  return name
    .split("-")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join("-");
}
