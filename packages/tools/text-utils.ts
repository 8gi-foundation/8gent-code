/**
 * text-utils.ts
 * Zero-dependency text utility library for terminal and general use.
 */

/**
 * Truncate a string at word boundaries to fit within maxLength.
 * If the string fits, return it unchanged. Otherwise cut at the last
 * word boundary before maxLength and append the suffix (default "...").
 */
export function truncate(text: string, maxLength: number, suffix = "..."): string {
  if (text.length <= maxLength) return text;
  const limit = maxLength - suffix.length;
  if (limit <= 0) return suffix.slice(0, maxLength);
  // Walk backwards from limit to find a word boundary
  let cut = limit;
  while (cut > 0 && text[cut] !== " " && text[cut] !== "\n" && text[cut] !== "\t") {
    cut--;
  }
  // If no word boundary found, hard-cut at limit
  if (cut === 0) cut = limit;
  return text.slice(0, cut).trimEnd() + suffix;
}

/**
 * Wrap text to fit within a given column width, breaking at word boundaries.
 * Returns an array of lines. Each line is at most width characters.
 */
export function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    const words = paragraph.split(" ").filter((w) => w.length > 0);
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        // Word alone may exceed width - still place it on its own line
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) lines.push(current);
  }
  return lines;
}

/** ANSI escape sequence pattern */
const ANSI_PATTERN = /[\u001b\u009b](?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

/**
 * Strip ANSI escape codes from a string, returning plain text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Convert a string to a URL/filesystem-safe slug.
 * Lowercases, replaces non-alphanumeric sequences with hyphens,
 * and trims leading/trailing hyphens.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Return the singular or plural form of a word based on count.
 * Uses naive English rules when no explicit plural is provided.
 *
 * @param count   The numeric count.
 * @param word    Singular form of the word.
 * @param plural  Optional explicit plural. If omitted, appends "s".
 */
export function pluralize(count: number, word: string, plural?: string): string {
  if (count === 1) return `1 ${word}`;
  const pl = plural ?? `${word}s`;
  return `${count} ${pl}`;
}

/** Byte size thresholds */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Format a byte count into a human-readable string (e.g. "1.23 MB").
 * Uses base-1024 (IEC) divisions.
 */
export function humanizeBytes(bytes: number, decimals = 2): string {
  if (bytes < 0) return `${bytes} B`;
  if (bytes === 0) return "0 B";
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const unit = BYTE_UNITS[unitIndex];
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(value * factor) / factor;
  return `${rounded} ${unit}`;
}

/**
 * Format a duration in milliseconds into a human-readable string.
 * Examples: "350ms", "4s", "2m 15s", "1h 3m", "2d 4h"
 */
export function humanizeDuration(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
