/**
 * Terminal table renderer with column alignment, borders, colors, truncation,
 * and responsive width. Zero dependencies beyond Node/Bun built-ins.
 */

export type Align = "left" | "center" | "right";

export interface ColumnDef {
  /** Column header label */
  header: string;
  /** Key to pluck from each row object */
  key: string;
  /** Fixed width (characters). Omit for auto-sized. */
  width?: number;
  /** Text alignment within the cell. Default: "left" */
  align?: Align;
  /** ANSI color code (e.g. "\x1b[36m" for cyan). Applied to cell text. */
  color?: string;
}

export interface TableOptions {
  /** Column definitions */
  columns: ColumnDef[];
  /** Row data - array of key-value objects */
  rows: Record<string, unknown>[];
  /** Maximum table width in characters. Default: terminal width or 80 */
  maxWidth?: number;
  /** Draw box-drawing borders. Default: true */
  borders?: boolean;
  /** Truncation suffix when cell overflows. Default: "..." */
  ellipsis?: string;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function pad(text: string, width: number, align: Align): string {
  const len = stripAnsi(text).length;
  const diff = Math.max(0, width - len);
  if (align === "right") return " ".repeat(diff) + text;
  if (align === "center") {
    const left = Math.floor(diff / 2);
    return " ".repeat(left) + text + " ".repeat(diff - left);
  }
  return text + " ".repeat(diff);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncate(text: string, max: number, ellipsis: string): string {
  if (stripAnsi(text).length <= max) return text;
  // Strip ANSI before truncating, then re-apply nothing (safe for terminal)
  const plain = stripAnsi(text);
  return plain.slice(0, Math.max(0, max - ellipsis.length)) + ellipsis;
}

function resolveWidths(
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
  maxWidth: number,
  borders: boolean,
): number[] {
  const borderOverhead = borders ? columns.length + 1 + columns.length * 2 : 0;
  const available = maxWidth - borderOverhead;

  const widths = columns.map((col, i) => {
    if (col.width) return col.width;
    const headerLen = col.header.length;
    const maxCell = rows.reduce((mx, row) => {
      const val = String(row[col.key] ?? "");
      return Math.max(mx, val.length);
    }, 0);
    return Math.max(headerLen, maxCell);
  });

  // Shrink proportionally if total exceeds available
  const total = widths.reduce((a, b) => a + b, 0);
  if (total > available && available > 0) {
    const ratio = available / total;
    for (let i = 0; i < widths.length; i++) {
      widths[i] = Math.max(3, Math.floor(widths[i] * ratio));
    }
  }

  return widths;
}

export function renderTable(opts: TableOptions): string {
  const {
    columns,
    rows,
    maxWidth = process.stdout.columns || 80,
    borders = true,
    ellipsis = "...",
  } = opts;

  const widths = resolveWidths(columns, rows, maxWidth, borders);
  const lines: string[] = [];

  const hr = (left: string, mid: string, right: string, fill: string) =>
    DIM + left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right + RESET;

  const row = (cells: string[]) => {
    const inner = cells
      .map((cell, i) => " " + pad(cell, widths[i], columns[i].align ?? "left") + " ")
      .join(borders ? DIM + "|" + RESET : "");
    return borders ? DIM + "|" + RESET + inner + DIM + "|" + RESET : inner;
  };

  // Top border
  if (borders) lines.push(hr("+", "+", "+", "-"));

  // Header
  const headerCells = columns.map((col, i) =>
    BOLD + truncate(col.header, widths[i], ellipsis) + RESET,
  );
  lines.push(row(headerCells));

  // Separator
  if (borders) lines.push(hr("+", "+", "+", "-"));

  // Data rows
  for (const r of rows) {
    const cells = columns.map((col, i) => {
      const raw = truncate(String(r[col.key] ?? ""), widths[i], ellipsis);
      return col.color ? col.color + raw + RESET : raw;
    });
    lines.push(row(cells));
  }

  // Bottom border
  if (borders) lines.push(hr("+", "+", "+", "-"));

  return lines.join("\n");
}
