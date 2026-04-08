/**
 * Markdown Table Parser & Generator
 * Parse markdown tables to structured data and generate formatted tables from arrays.
 */

export type Alignment = "left" | "center" | "right" | "none";

export interface ParsedTable {
  headers: string[];
  alignments: Alignment[];
  rows: string[][];
}

/** Parse a markdown table string into structured data. Returns null if invalid. */
export function parseTable(md: string): ParsedTable | null {
  const lines = md
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return null;

  const separatorLine = lines[1];
  if (!/^\|?[\s\-:|]+\|/.test(separatorLine)) return null;

  const headers = splitRow(lines[0]);
  if (headers.length === 0) return null;

  const alignments = parseSeparator(separatorLine, headers.length);

  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const row = splitRow(lines[i]);
    if (row.length === 0) continue;
    while (row.length < headers.length) row.push("");
    rows.push(row.slice(0, headers.length));
  }

  return { headers, alignments, rows };
}

/**
 * Generate a formatted markdown table from headers and rows.
 * Alignments default to left when omitted.
 */
export function generateTable(
  rows: string[][],
  headers: string[],
  alignments?: Alignment[]
): string {
  const cols = headers.length;
  const aligns: Alignment[] = Array.from(
    { length: cols },
    (_, i) => (alignments && alignments[i]) || "left"
  );

  const widths = headers.map((h, i) => {
    let max = Math.max(h.length, 3);
    for (const row of rows) {
      const len = (row[i] ?? "").length;
      if (len > max) max = len;
    }
    return max;
  });

  const header = fmtRow(headers, widths);
  const sep = fmtSeparator(aligns, widths);
  const body = rows.map((row) =>
    fmtRow(headers.map((_, i) => row[i] ?? ""), widths)
  );

  return [header, sep, ...body].join("\n");
}

// --- helpers ---

function splitRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function parseSeparator(line: string, cols: number): Alignment[] {
  const cells = splitRow(line);
  return Array.from({ length: cols }, (_, i) => {
    const c = (cells[i] ?? "").trim();
    if (c.startsWith(":") && c.endsWith(":")) return "center";
    if (c.endsWith(":")) return "right";
    if (c.startsWith(":")) return "left";
    return "none";
  });
}

function fmtRow(cells: string[], widths: number[]): string {
  return "| " + cells.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |";
}

function fmtSeparator(aligns: Alignment[], widths: number[]): string {
  const parts = aligns.map((a, i) => {
    const dashes = "-".repeat(widths[i]);
    if (a === "center") return ":" + dashes + ":";
    if (a === "right")  return dashes + ":";
    if (a === "left")   return ":" + dashes;
    return dashes;
  });
  return "| " + parts.join(" | ") + " |";
}
