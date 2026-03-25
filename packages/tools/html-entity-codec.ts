/**
 * HTML Entity Codec
 * Encodes and decodes HTML entities for safe content rendering and XSS prevention.
 * Handles named entities, numeric decimal, and numeric hex entities.
 */

// Named entities map: char -> entity name
const NAMED_ENCODE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "/": "&#x2F;",
  "`": "&#x60;",
  "=": "&#x3D;",
};

// Extended named entities for decode: entity name -> char
const NAMED_DECODE: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  mdash: "\u2014",
  ndash: "\u2013",
  laquo: "\u00AB",
  raquo: "\u00BB",
  hellip: "\u2026",
  ldquo: "\u201C",
  rdquo: "\u201D",
  lsquo: "\u2018",
  rsquo: "\u2019",
  bull: "\u2022",
  euro: "\u20AC",
  pound: "\u00A3",
  yen: "\u00A5",
  cent: "\u00A2",
  sect: "\u00A7",
  para: "\u00B6",
  deg: "\u00B0",
  plusmn: "\u00B1",
  frac12: "\u00BD",
  frac14: "\u00BC",
  frac34: "\u00BE",
  times: "\u00D7",
  divide: "\u00F7",
  iexcl: "\u00A1",
  iquest: "\u00BF",
  acute: "\u00B4",
  cedil: "\u00B8",
  uml: "\u00A8",
};

/**
 * Encodes a string by replacing special characters with HTML entities.
 * Safe for use in HTML text content.
 */
export function encodeHTML(str: string): string {
  if (typeof str !== "string") return "";
  return str.replace(/[&<>"'`=/]/g, (char) => NAMED_ENCODE[char] ?? char);
}

/**
 * Decodes HTML entities (named, decimal numeric, and hex numeric) back to characters.
 * Handles malformed or unknown entities gracefully by leaving them as-is.
 */
export function decodeHTML(str: string): string {
  if (typeof str !== "string") return "";

  return str.replace(/&([^;]{1,32});/g, (match, entity: string) => {
    // Numeric hex: &#x41; -> 'A'
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = parseInt(entity.slice(2), 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }

    // Numeric decimal: &#65; -> 'A'
    if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }

    // Named entity
    const decoded = NAMED_DECODE[entity.toLowerCase()];
    return decoded ?? match;
  });
}

/**
 * Escapes a string for safe use inside an HTML attribute value (quoted or unquoted).
 * More aggressive than encodeHTML - also encodes tab, newline, and carriage return.
 */
export function escapeForAttribute(str: string): string {
  if (typeof str !== "string") return "";

  return str.replace(/[&<>"'`=/\t\n\r]/g, (char) => {
    if (char in NAMED_ENCODE) return NAMED_ENCODE[char]!;
    // Encode control chars as numeric entities
    const code = char.charCodeAt(0);
    return `&#x${code.toString(16).toUpperCase()};`;
  });
}

/**
 * Returns true if the given code point is safe to render (not a control character
 * or surrogate that would produce garbage output or XSS vectors).
 */
function isValidCodePoint(code: number): boolean {
  if (!Number.isInteger(code) || code < 0) return false;
  if (code === 0) return false;                           // null byte
  if (code >= 0xd800 && code <= 0xdfff) return false;   // surrogates
  if (code > 0x10ffff) return false;                     // outside Unicode range
  return true;
}
