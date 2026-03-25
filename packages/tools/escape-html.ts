/**
 * Context-aware escaping for safe output in HTML, JavaScript, CSS, and URLs.
 * Prevents XSS and injection attacks in generated content.
 */

export type EscapeContext = "html" | "js" | "css" | "url" | "attribute";

/** HTML entity map for character escaping */
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
  "`": "&#x60;",
};

/** JavaScript escape map - covers chars that break string literals */
const JS_ESCAPE_MAP: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "'": "\\'",
  "`": "\\`",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\0": "\\0",
  "\u2028": "\\u2028", // line separator - valid JS line terminator
  "\u2029": "\\u2029", // paragraph separator - valid JS line terminator
};

/**
 * Escape a string for safe insertion into HTML text content.
 * Handles &, <, >, ", ', ` to prevent HTML injection.
 */
export function escapeHtml(str: string): string {
  if (typeof str !== "string") return String(str);
  return str.replace(/[&<>"'`]/g, (char) => HTML_ENTITIES[char] ?? char);
}

/**
 * Escape a string for safe insertion into a JavaScript string literal.
 * Handles backslashes, quotes, newlines, and Unicode line terminators.
 */
export function escapeJs(str: string): string {
  if (typeof str !== "string") return String(str);
  return str.replace(/[\\"`'\n\r\t\0\u2028\u2029]/g, (char) => {
    return JS_ESCAPE_MAP[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/**
 * Escape a string for safe insertion into a CSS string value or identifier.
 * Escapes characters outside printable ASCII and CSS-sensitive chars.
 */
export function escapeCss(str: string): string {
  if (typeof str !== "string") return String(str);
  return str.replace(/[^\w\s-]/g, (char) => {
    const code = char.charCodeAt(0);
    // Printable ASCII range - escape CSS special chars
    if (code < 128) {
      return `\\${char}`;
    }
    // Non-ASCII - use unicode escape
    return `\\${code.toString(16).padStart(6, "0")} `;
  });
}

/**
 * Escape a string for safe insertion into a URL component (query param value, path segment).
 * Uses encodeURIComponent semantics - encodes all chars except unreserved.
 */
export function escapeUrl(str: string): string {
  if (typeof str !== "string") return encodeURIComponent(String(str));
  return encodeURIComponent(str);
}

/**
 * Escape a string for safe insertion into an HTML attribute value (inside quotes).
 * More aggressive than escapeHtml - also escapes forward slashes.
 */
export function escapeAttribute(str: string): string {
  if (typeof str !== "string") return String(str);
  return str.replace(/[&<>"'`/]/g, (char) => {
    if (char === "/") return "&#x2F;";
    return HTML_ENTITIES[char] ?? char;
  });
}

/**
 * Context-aware escaping dispatcher.
 * Selects the correct escaping strategy based on the output context.
 *
 * @param str - The string to escape
 * @param context - The target context: "html" | "js" | "css" | "url" | "attribute"
 * @returns Safely escaped string for the given context
 *
 * @example
 * escapeForContext('<script>alert(1)</script>', 'html')
 * // => '&lt;script&gt;alert(1)&lt;/script&gt;'
 *
 * escapeForContext("it's a \"test\"", 'js')
 * // => "it\\'s a \\"test\\""
 *
 * escapeForContext('color: red; background: url(evil)', 'css')
 * // => 'color\: red\; background\: url\(evil\)'
 */
export function escapeForContext(str: string, context: EscapeContext): string {
  switch (context) {
    case "html":
      return escapeHtml(str);
    case "js":
      return escapeJs(str);
    case "css":
      return escapeCss(str);
    case "url":
      return escapeUrl(str);
    case "attribute":
      return escapeAttribute(str);
    default: {
      const exhaustive: never = context;
      throw new Error(`Unknown escape context: ${exhaustive}`);
    }
  }
}
