/**
 * string-pad.ts
 *
 * ANSI-aware string padding - padStart, padEnd, padCenter, and padColumns
 * for terminal tables. Measures visible width, ignoring ANSI escape codes.
 */

// Matches ANSI escape sequences (colors, styles, cursor moves, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJsuhlp]/g;

/** Return the visible (printable) length of a string, ignoring ANSI codes. */
export function visibleWidth(str: string): number {
  return str.replace(ANSI_RE, "").length;
}

/**
 * Build a repeat string of `char` to fill `count` visible characters.
 * Uses the first character of `char` if multi-char is passed.
 */
function fillChars(char: string, count: number): string {
  if (count <= 0) return "";
  const c = (char || " ")[0];
  return c.repeat(count);
}

/**
 * Pad the start of `str` so its visible width reaches `len`.
 * If `str` is already >= `len` visible chars, it is returned unchanged.
 *
 * @param str   Input string (may contain ANSI codes)
 * @param len   Target visible width
 * @param char  Pad character. Default: " "
 */
export function padStart(str: string, len: number, char = " "): string {
  const gap = len - visibleWidth(str);
  if (gap <= 0) return str;
  return fillChars(char, gap) + str;
}

/**
 * Pad the end of `str` so its visible width reaches `len`.
 * If `str` is already >= `len` visible chars, it is returned unchanged.
 *
 * @param str   Input string (may contain ANSI codes)
 * @param len   Target visible width
 * @param char  Pad character. Default: " "
 */
export function padEnd(str: string, len: number, char = " "): string {
  const gap = len - visibleWidth(str);
  if (gap <= 0) return str;
  return str + fillChars(char, gap);
}

/**
 * Pad both sides of `str` so its visible width reaches `len`.
 * Extra padding (when gap is odd) goes to the right.
 * If `str` is already >= `len` visible chars, it is returned unchanged.
 *
 * @param str   Input string (may contain ANSI codes)
 * @param len   Target visible width
 * @param char  Pad character. Default: " "
 */
export function padCenter(str: string, len: number, char = " "): string {
  const gap = len - visibleWidth(str);
  if (gap <= 0) return str;
  const left = Math.floor(gap / 2);
  const right = gap - left;
  return fillChars(char, left) + str + fillChars(char, right);
}

/** Column alignment options for padColumns. */
export type Alignment = "left" | "right" | "center";

export interface PadColumnsOptions {
  /**
   * Per-column alignment. Indices not specified default to "left".
   * Can also be a single Alignment to apply to all columns.
   */
  alignments?: Alignment[] | Alignment;
  /** Column separator. Default: "  " (two spaces) */
  separator?: string;
}

/**
 * Align a 2D array of strings into fixed-width columns.
 * Each column is sized to the widest visible cell in that column.
 * Returns one formatted string per row.
 *
 * @param rows        2D array - rows[row][col]
 * @param options     Optional alignment and separator config
 */
export function padColumns(
  rows: string[][],
  options: PadColumnsOptions = {}
): string[] {
  const { separator = "  " } = options;

  if (rows.length === 0) return [];

  // Determine column count
  const colCount = Math.max(...rows.map((r) => r.length));

  // Measure max visible width per column
  const widths: number[] = Array.from({ length: colCount }, (_, ci) =>
    Math.max(...rows.map((row) => visibleWidth(row[ci] ?? "")))
  );

  // Resolve alignment per column
  const alignments: Alignment[] = Array.from({ length: colCount }, (_, ci) => {
    if (!options.alignments) return "left";
    if (typeof options.alignments === "string") return options.alignments;
    return options.alignments[ci] ?? "left";
  });

  return rows.map((row) => {
    const cells = Array.from({ length: colCount }, (_, ci) => {
      const cell = row[ci] ?? "";
      const w = widths[ci];
      const align = alignments[ci];
      if (align === "right") return padStart(cell, w);
      if (align === "center") return padCenter(cell, w);
      return padEnd(cell, w); // left (default)
    });
    return cells.join(separator);
  });
}
