/**
 * Text manipulation utilities for terminal display.
 * Pure functions, no dependencies on React or Ink.
 */

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escape codes from a string. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_REGEX, "");
}

/** Get the visible length of a string after stripping ANSI codes. */
export function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

/** Truncate a string to `max` characters, appending "…" if truncated. */
export function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  if (max === 1) return value.length > 1 ? "\u2026" : value;
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "\u2026";
}

/** Alias for truncate. */
export const ellipsis = truncate;

/** Pad a string with trailing spaces to a fixed width. */
export function padRight(value: string, width: number): string {
  const visible = visibleLength(value);
  if (visible >= width) return value;
  return value + " ".repeat(width - visible);
}

/** Center a string within a fixed width, padding both sides with spaces. */
export function padCenter(value: string, width: number): string {
  const visible = visibleLength(value);
  if (visible >= width) return value;
  const totalPad = width - visible;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return " ".repeat(left) + value + " ".repeat(right);
}

/** Safely repeat a character `count` times. Returns "" for count <= 0. */
export function repeatChar(char: string, count: number): string {
  if (count <= 0) return "";
  return char.repeat(count);
}

/** Word-wrap text into an array of lines, each at most `width` characters. */
export function wrapText(value: string, width: number): string[] {
  if (width <= 0) return [];
  if (value.length === 0) return [""];

  const lines: string[] = [];
  const paragraphs = value.split("\n");

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }

    const words = paragraph.split(/\s+/);
    let current = "";

    for (const word of words) {
      if (word.length === 0) continue;

      if (current.length === 0) {
        // Word longer than width gets force-broken
        if (word.length > width) {
          let remaining = word;
          while (remaining.length > width) {
            lines.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
          }
          current = remaining;
        } else {
          current = word;
        }
      } else if (current.length + 1 + word.length <= width) {
        current += " " + word;
      } else {
        lines.push(current);
        if (word.length > width) {
          let remaining = word;
          while (remaining.length > width) {
            lines.push(remaining.slice(0, width));
            remaining = remaining.slice(width);
          }
          current = remaining;
        } else {
          current = word;
        }
      }
    }

    if (current.length > 0) {
      lines.push(current);
    }
  }

  return lines;
}
