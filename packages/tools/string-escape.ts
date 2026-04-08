/**
 * string-escape.ts
 * Context-specific string escaping utilities.
 * Supports: regex, HTML, XML, JSON, shell, SQL.
 */

// ---------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------

/**
 * Escapes all regex metacharacters so the string can be used as a literal
 * pattern inside `new RegExp(...)`.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const HTML_UNESCAPE_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&#x2F;": "/",
  "&#47;": "/",
};

/** Escapes `& < > " '` for safe insertion into HTML text or attribute values. */
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

/** Reverses common HTML entities back to their characters. */
export function unescapeHtml(str: string): string {
  return str
    .replace(
      /&(?:amp|lt|gt|quot|#39|#x27|#x2F|#47);/g,
      (entity) => HTML_UNESCAPE_MAP[entity] ?? entity
    )
    // Numeric decimal entities: &#NNN;
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    // Numeric hex entities: &#xHHH;
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    );
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * Escapes the five predefined XML entities plus the vertical tab / null byte
 * which are illegal in XML 1.0.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""); // strip illegal chars
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Escapes a string value for safe embedding inside a JSON string literal.
 * Handles backslash, double-quote, and all control characters.
 */
export function escapeJson(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/[\x00-\x1F\x7F]/g, (ch) => {
      const hex = ch.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${hex}`;
    });
}

/**
 * Parses JSON-style escape sequences back to their characters.
 * Handles `\\ \" \n \r \t \uXXXX`.
 */
export function unescapeJson(str: string): string {
  return str.replace(
    /\\(["\\\/bfnrt]|u[0-9a-fA-F]{4})/g,
    (_, seq: string) => {
      switch (seq[0]) {
        case '"':  return '"';
        case '\\': return '\\';
        case '/':  return '/';
        case 'b':  return '\b';
        case 'f':  return '\f';
        case 'n':  return '\n';
        case 'r':  return '\r';
        case 't':  return '\t';
        case 'u':  return String.fromCharCode(parseInt(seq.slice(1), 16));
        default:   return seq;
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Shell (POSIX)
// ---------------------------------------------------------------------------

/**
 * Wraps a string in single quotes and escapes any embedded single quotes
 * using the POSIX `'\''` trick. Safe for use in `sh`/`bash` command strings.
 *
 * @example
 *   escapeShell("it's alive") // => "'it'\\''s alive'"
 */
export function escapeShell(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// SQL (generic single-quote escaping)
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe use as a SQL string literal by doubling any
 * single-quote characters. Works with standard ANSI SQL and most dialects
 * (PostgreSQL, SQLite, MySQL with ANSI_QUOTES, SQL Server).
 *
 * NOTE: Always prefer parameterised queries. Use this only when you have
 * no choice (e.g., DDL statements, dynamic identifiers).
 */
export function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}
