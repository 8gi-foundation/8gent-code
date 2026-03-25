/**
 * Markdown Table Parser & Generator
 * Bidirectional utility: parse markdown tables to structured data,
 * generate formatted markdown tables from arrays with alignment support.
 */

export type Alignment = "left" | "center" | "right" | "none";

export interface ParsedTable {
  headers: string[];
  alignments: Alignment[];
  rows: string[][];
}

/**
 * Parse a markdown table string into structured data.
 * Returns null if the input is not a valid markdown table.
 */
export function parseTable(md: string): ParsedTable | null {
  const lines = md
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return null;

  const headerLine = lines[0];
  const separatorLine = lines[1];

  // Separator must be a divider row (e.g. |---|:---:|---:|)
  if (!/^\|?[\s\-:|]+\|/.test(separatorLine)) return null;

  const headers = parseRow(headerLine);
  if (headers.length === 0) return null;

  const alignments = parseSeparator(separatorLine, headers.length);

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    if (row.length === 0) continue;
    // Pad or trim to match header column count
    while (row.length < headers.length) row.push("");
    rows.push(row.slice(0, headers.length));
  }

  return { headers, alignments, rows };
}

/**
 * Generate a formatted markdown table from headers and row data.
 * Optionally pass alignments per column; defaults to left-aligned.
 */
export function generateTable(
  rows: string[][],
  headers: string[],
  alignments?: Alignment[]
): string {
  const cols = headers.length;
  const aligns: Alignment[] = alignments
    ? alignments.slice(0, cols)
    : Array(cols).fill("left");

  // Pad missing alignment entries
  while (aligns.length < cols) aligns.push("left");

  // Compute column widths
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const cell = row[i] ?? "";
      if (cell.length > max) max = cell.length;
    }
    // Minimum width of 3 for separator readability
    return Math.max(max, 3);
  });

  const header = buildRow(headers, widths);
  const separator = buildSeparator(aligns, widths);
  const body = rows.map((row) => {
    const padded = headers.map((_, i) => row[i] ?? "");
    return buildRow(padded, widths);
  });

  return [header, separator, ...body].join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseRow(line: string): string[] {
  // Strip leading/trailing pipes, split on |
  const stripped = line.replace(/^\||\|$/g, "");
  return stripped.split("|").map((cell) => cell.trim());
}

function parseSeparator(line: string, cols: number): Alignment[] {
  const cells = parseRow(line);
  return Array.from({ length: cols }, (_, i) => {
    const cell = (cells[i] ?? "").trim();
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "none";
  });
}

function buildRow(cells: string[], widths: number[]): string {
  const parts = cells.map((cell, i) => ` ${cell.padEnd(widths[i])} `);
  return `|${parts.join("|")}|`;
}

function buildSeparator(aligns: Alignment[], widths: number[]): string {
  const parts = aligns.map((align, i) => {
    const w = widths[i];
    const dashes = "-".repeat(w);
    if (align === "center") return `:${dashes}:`;
    if (align === "right") return `${dashes}:`;
    if (align === "left") return `:${dashes}`;
    return `-${dashes}-`;
  });
  return `|${parts.map((p) => ` ${p} `).join("|")}|`;
}
