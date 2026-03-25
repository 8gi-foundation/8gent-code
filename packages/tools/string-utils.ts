/**
 * @8gent/tools - String utility functions
 *
 * Pure, dependency-free string helpers used across the 8gent ecosystem.
 * No external deps - everything is hand-rolled for minimal bundle size.
 */

// Strip ANSI escape codes (colors, cursor movement, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

// Truncate string to maxLen, appending suffix if trimmed
export function truncate(
  str: string,
  maxLen: number,
  suffix = "..."
): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - suffix.length) + suffix;
}

// Word-wrap text to a given width, breaking on spaces
export function wordWrap(str: string, width: number): string {
  if (width < 1) return str;
  const lines: string[] = [];
  for (const paragraph of str.split("\n")) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += " " + word;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

// URL/filename-safe slug: "Hello World!" -> "hello-world"
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// "foo-bar_baz qux" -> "fooBarBazQux"
export function camelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ""))
    .replace(/^[A-Z]/, (ch) => ch.toLowerCase());
}

// "fooBar baz-qux" -> "foo_bar_baz_qux"
export function snakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

// "hello world" -> "Hello World"
export function titleCase(str: string): string {
  return str.replace(
    /\b\w/g,
    (ch) => ch.toUpperCase()
  );
}

// Center-pad a string within a given width
export function padCenter(str: string, width: number, fill = " "): string {
  if (str.length >= width) return str;
  const total = width - str.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return fill.repeat(left) + str + fill.repeat(right);
}

// Simple English pluralization: pluralize(1, "file") -> "1 file", pluralize(3, "file") -> "3 files"
// Supports explicit plural: pluralize(2, "child", "children") -> "2 children"
export function pluralize(
  count: number,
  singular: string,
  plural?: string
): string {
  const word = count === 1 ? singular : (plural ?? singular + "s");
  return `${count} ${word}`;
}

// Human-readable byte sizes: 1536 -> "1.5 KB"
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function humanizeBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const sign = bytes < 0 ? "-" : "";
  let abs = Math.abs(bytes);
  let unitIdx = 0;
  while (abs >= 1024 && unitIdx < BYTE_UNITS.length - 1) {
    abs /= 1024;
    unitIdx++;
  }
  const value = unitIdx === 0 ? abs.toString() : abs.toFixed(decimals);
  return `${sign}${value} ${BYTE_UNITS[unitIdx]}`;
}
