/**
 * markdown-frontmatter.ts
 * Parse and generate YAML frontmatter from markdown files.
 * Handles --- delimited blocks at the start of a document.
 */

export interface FrontmatterResult {
  /** Parsed frontmatter as a key-value object. Empty if none found. */
  data: Record<string, unknown>;
  /** The markdown content with frontmatter stripped. */
  content: string;
  /** True if a frontmatter block was present. */
  hasFrontmatter: boolean;
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a YAML value string into a JS primitive or array.
 * Handles: strings, numbers, booleans, null, and simple inline arrays.
 */
function parseValue(raw: string): unknown {
  const v = raw.trim();

  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;

  // Quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);

  // Inline array: [a, b, c]
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((item) => parseValue(item.trim()));
  }

  return v;
}

/**
 * Minimal YAML parser - handles flat key: value and block list items.
 * Does NOT handle nested objects or multi-line values.
 */
function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Block list item under current key
    if (line.match(/^\s+-\s+/) && currentKey) {
      const item = parseValue(line.replace(/^\s+-\s+/, ""));
      if (!currentList) {
        currentList = [];
        result[currentKey] = currentList;
      }
      currentList.push(item);
      continue;
    }

    // key: value pair
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    currentKey = key;
    currentList = null;

    if (rawVal === "" || rawVal === "|" || rawVal === ">") {
      result[key] = "";
    } else {
      result[key] = parseValue(rawVal);
    }
  }

  return result;
}

/**
 * Serialize a JS value to a YAML-compatible string for frontmatter output.
 */
function serializeValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  if (Array.isArray(val)) return `[${val.map(serializeValue).join(", ")}]`;
  const str = String(val);
  if (/[:#\[\]{},&*?|<>=!%@`]/.test(str) || str.includes("\n")) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * @param md - Raw markdown content (may or may not have frontmatter)
 * @returns FrontmatterResult with parsed data, stripped content, and presence flag
 *
 * @example
 * const { data, content } = parseFrontmatter("---\ntitle: Hello\n---\n# Body");
 * // data = { title: "Hello" }, content = "# Body"
 */
export function parseFrontmatter(md: string): FrontmatterResult {
  const match = md.match(FRONTMATTER_REGEX);

  if (!match) {
    return { data: {}, content: md, hasFrontmatter: false };
  }

  const yamlBlock = match[1];
  const body = match[2] ?? "";

  return {
    data: parseYaml(yamlBlock),
    content: body,
    hasFrontmatter: true,
  };
}

/**
 * Generate a markdown string with YAML frontmatter prepended to content.
 *
 * @param data - Object to serialize as YAML frontmatter
 * @param content - Markdown body to append after the frontmatter block
 * @returns Full markdown string with --- delimited frontmatter header
 *
 * @example
 * generateFrontmatter({ title: "Hello", draft: false }, "# Body\nText");
 * // "---\ntitle: Hello\ndraft: false\n---\n# Body\nText"
 */
export function generateFrontmatter(
  data: Record<string, unknown>,
  content: string
): string {
  const lines: string[] = [];

  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val) && val.length > 3) {
      lines.push(`${key}:`);
      for (const item of val) {
        lines.push(`  - ${serializeValue(item)}`);
      }
    } else {
      lines.push(`${key}: ${serializeValue(val)}`);
    }
  }

  const yaml = lines.join("\n");
  const separator = content.startsWith("\n") ? "" : "\n";
  return `---\n${yaml}\n---\n${separator}${content}`;
}
