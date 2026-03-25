/**
 * table-formatter.ts
 * Format arrays of objects as aligned ASCII or Unicode tables for terminal display.
 */

export type Alignment = "left" | "right" | "center";
export type BorderStyle = "none" | "ascii" | "unicode";

export interface ColumnOptions {
  key: string;
  header?: string;
  align?: Alignment;
  maxWidth?: number;
}

export interface TableOptions {
  columns?: ColumnOptions[];
  border?: BorderStyle;
  maxWidth?: number;
  headerBold?: boolean;
}

interface Borders {
  topLeft: string; top: string; topMid: string; topRight: string;
  midLeft: string; mid: string; midMid: string; midRight: string;
  botLeft: string; bot: string; botMid: string; botRight: string;
  vert: string;
}

const BORDERS: Record<BorderStyle, Borders> = {
  none: {
    topLeft: "", top: "", topMid: "", topRight: "",
    midLeft: "", mid: "-", midMid: " ", midRight: "",
    botLeft: "", bot: "", botMid: "", botRight: "",
    vert: "  ",
  },
  ascii: {
    topLeft: "+", top: "-", topMid: "+", topRight: "+",
    midLeft: "+", mid: "-", midMid: "+", midRight: "+",
    botLeft: "+", bot: "-", botMid: "+", botRight: "+",
    vert: "|",
  },
  unicode: {
    topLeft: "┌", top: "─", topMid: "┬", topRight: "┐",
    midLeft: "├", mid: "─", midMid: "┼", midRight: "┤",
    botLeft: "└", bot: "─", botMid: "┴", botRight: "┘",
    vert: "│",
  },
};

function pad(str: string, width: number, align: Alignment): string {
  const len = str.length;
  if (len >= width) return str;
  const diff = width - len;
  if (align === "right") return " ".repeat(diff) + str;
  if (align === "center") {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return " ".repeat(left) + str + " ".repeat(right);
  }
  return str + " ".repeat(diff);
}

function truncate(str: string, maxWidth: number): string {
  if (str.length <= maxWidth) return str;
  if (maxWidth <= 3) return str.slice(0, maxWidth);
  return str.slice(0, maxWidth - 3) + "...";
}

function buildRow(cells: string[], widths: number[], b: Borders): string {
  const inner = cells.map((c, i) => ` ${c} `).join(b.vert);
  if (b.vert === "  ") {
    // none style: just join with double space
    return cells.map((c, i) => c).join("  ");
  }
  return `${b.vert}${inner}${b.vert}`;
}

function buildSep(widths: number[], b: Borders, which: "top" | "mid" | "bot"): string {
  const map = { top: [b.topLeft, b.top, b.topMid, b.topRight], mid: [b.midLeft, b.mid, b.midMid, b.midRight], bot: [b.botLeft, b.bot, b.botMid, b.botRight] };
  const [left, fill, mid, right] = map[which];
  if (!left && !fill && !mid && !right) return "";
  const parts = widths.map(w => fill.repeat(w + 2));
  return `${left}${parts.join(mid)}${right}`;
}

/**
 * Format an array of objects as an aligned terminal table.
 *
 * @param data    - Array of plain objects to display.
 * @param options - Optional configuration for columns, border style, alignment, and width.
 * @returns       - Multi-line string ready to print to a terminal.
 */
export function formatTable<T extends Record<string, unknown>>(
  data: T[],
  options: TableOptions = {}
): string {
  if (data.length === 0) return "(no data)";

  const { border = "unicode", maxWidth, headerBold = true } = options;
  const b = BORDERS[border];

  // Build column specs
  const keys = options.columns?.map(c => c.key) ?? Object.keys(data[0]);
  const colMap = new Map<string, ColumnOptions>(
    (options.columns ?? keys.map(k => ({ key: k }))).map(c => [c.key, c])
  );

  // Determine column widths
  const headers = keys.map(k => colMap.get(k)?.header ?? k);
  const widths = keys.map((k, i) => {
    const colMax = colMap.get(k)?.maxWidth ?? maxWidth ?? Infinity;
    const headerLen = headers[i].length;
    const dataLen = Math.max(...data.map(row => String(row[k] ?? "").length));
    return Math.min(Math.max(headerLen, dataLen), colMax);
  });

  const rows: string[] = [];

  // Top border
  const top = buildSep(widths, b, "top");
  if (top) rows.push(top);

  // Header row
  const headerCells = keys.map((k, i) => {
    const align: Alignment = colMap.get(k)?.align ?? "left";
    const cell = truncate(headers[i], widths[i]);
    const padded = pad(cell, widths[i], align);
    return headerBold ? `\x1b[1m${padded}\x1b[0m` : padded;
  });
  rows.push(buildRow(headerCells, widths, b));

  // Header separator
  const mid = buildSep(widths, b, "mid");
  if (mid) rows.push(mid);

  // Data rows
  for (const row of data) {
    const cells = keys.map((k, i) => {
      const align: Alignment = colMap.get(k)?.align ?? "left";
      const raw = String(row[k] ?? "");
      return pad(truncate(raw, widths[i]), widths[i], align);
    });
    rows.push(buildRow(cells, widths, b));
  }

  // Bottom border
  const bot = buildSep(widths, b, "bot");
  if (bot) rows.push(bot);

  return rows.join("\n");
}
