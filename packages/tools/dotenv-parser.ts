/**
 * dotenv-parser - Parse .env files with variable expansion and multiline support
 *
 * Handles:
 * - Quoted values (single and double quotes)
 * - Multiline values (double-quoted with literal newlines)
 * - Inline comments (# after unquoted value)
 * - Line comments (# at start of line)
 * - Variable expansion ($VAR and ${VAR})
 * - Empty values and export prefix
 */

export interface ParseOptions {
  /** If true, expand $VAR/${VAR} references using already-parsed keys */
  expand?: boolean;
  /** Override the environment used for expansion lookups (default: process.env) */
  env?: Record<string, string>;
}

/**
 * Parse .env file content into a key/value object.
 */
export function parseDotenv(
  content: string,
  options: ParseOptions = {}
): Record<string, string> {
  const { expand = true, env = process.env as Record<string, string> } = options;
  const result: Record<string, string> = {};
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines and full-line comments
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // Strip optional "export " prefix
    const stripped = line.replace(/^export\s+/, "");

    // Must contain an = sign
    const eqIdx = stripped.indexOf("=");
    if (eqIdx === -1) {
      i++;
      continue;
    }

    const key = stripped.slice(0, eqIdx).trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      i++;
      continue;
    }

    let rawValue = stripped.slice(eqIdx + 1);
    let value: string;

    if (rawValue.startsWith('"')) {
      // Double-quoted: collect lines until closing unescaped "
      let collected = rawValue.slice(1);
      let closed = false;
      const parts: string[] = [];

      while (true) {
        const closeIdx = findUnescapedQuote(collected, '"');
        if (closeIdx !== -1) {
          parts.push(collected.slice(0, closeIdx));
          closed = true;
          break;
        }
        parts.push(collected);
        i++;
        if (i >= lines.length) break;
        collected = lines[i];
      }

      if (!closed) {
        value = parts.join("\n");
      } else {
        value = parts.join("\n");
      }

      // Unescape escape sequences
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (rawValue.startsWith("'")) {
      // Single-quoted: no escaping, no expansion, ends at next '
      const closeIdx = rawValue.indexOf("'", 1);
      value = closeIdx === -1 ? rawValue.slice(1) : rawValue.slice(1, closeIdx);
    } else {
      // Unquoted: strip inline comment and trailing whitespace
      const commentIdx = rawValue.search(/\s+#/);
      value = (commentIdx === -1 ? rawValue : rawValue.slice(0, commentIdx)).trim();
    }

    if (expand) {
      value = expandVariables(value, result, env);
    }

    result[key] = value;
    i++;
  }

  return result;
}

/**
 * Load and parse a .env file from disk.
 */
export async function loadDotenv(
  filePath: string,
  options: ParseOptions = {}
): Promise<Record<string, string>> {
  const file = Bun.file(filePath);
  const content = await file.text();
  return parseDotenv(content, options);
}

// --- Helpers ---

function findUnescapedQuote(str: string, quote: string): number {
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\" ) { i += 2; continue; }
    if (str[i] === quote) return i;
    i++;
  }
  return -1;
}

function expandVariables(
  value: string,
  local: Record<string, string>,
  env: Record<string, string>
): string {
  // Replace ${VAR} and $VAR patterns
  return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
    const name = braced ?? bare;
    return local[name] ?? env[name] ?? "";
  });
}
