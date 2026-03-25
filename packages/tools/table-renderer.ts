/**
 * table-renderer.ts
 *
 * Render data tables to ANSI terminal output using Unicode box-drawing characters.
 * Zero external dependencies. Auto-sizes columns, supports alignment, color,
 * compact mode, and truncation of long cells.
 */

// ANSI escape codes
const A = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  cyan:      '\x1b[36m',
  yellow:    '\x1b[33m',
  green:     '\x1b[32m',
  blue:      '\x1b[34m',
  red:       '\x1b[31m',
} as const;

// --- box-drawing sets ---------------------------------------------------------

interface BoxSet {
  topLeft:     string;
  topRight:    string;
  bottomLeft:  string;
  bottomRight: string;
  topMid:      string;
  bottomMid:   string;
  midLeft:     string;
  midRight:    string;
  midMid:      string;
  horiz:       string;
  vert:        string;
}

const BOX_NORMAL: BoxSet = {
  topLeft:     '\u250C', topRight:    '\u2510',
  bottomLeft:  '\u2514', bottomRight: '\u2518',
  topMid:      '\u252C', bottomMid:   '\u2534',
  midLeft:     '\u251C', midRight:    '\u2524',
  midMid:      '\u253C', horiz:       '\u2500',
  vert:        '\u2502',
};

const BOX_COMPACT: BoxSet = {
  topLeft:     '+', topRight:    '+',
  bottomLeft:  '+', bottomRight: '+',
  topMid:      '+', bottomMid:   '+',
  midLeft:     '+', midRight:    '+',
  midMid:      '+', horiz:       '-',
  vert:        '|',
};

// --- types --------------------------------------------------------------------

export type Alignment = 'left' | 'right' | 'center';

export type CellColor = 'cyan' | 'yellow' | 'green' | 'blue' | 'red' | 'dim' | 'bold' | 'none';

export interface ColumnDef {
  /** Column header label */
  header: string;
  /** Key to pull from row objects, or index for array rows */
  key: string | number;
  /** Text alignment within the column (default: 'left') */
  align?: Alignment;
  /** Maximum cell width before truncation (default: no limit) */
  maxWidth?: number;
  /** ANSI color applied to data cells in this column */
  color?: CellColor;
  /** Minimum column width (default: header length) */
  minWidth?: number;
}

export interface TableOptions {
  /** Column definitions. If omitted, inferred from first row. */
  columns?: ColumnDef[];
  /** Color applied to header row (default: 'bold') */
  headerColor?: CellColor;
  /** Use compact ASCII borders instead of Unicode box-drawing */
  compact?: boolean;
  /** Max width for any column when auto-sizing (default: 40) */
  defaultMaxWidth?: number;
  /** Cell padding on each side (default: 1) */
  padding?: number;
  /** Show row separators between data rows */
  rowSeparators?: boolean;
  /** Caption rendered above the table */
  caption?: string;
}

// --- utils --------------------------------------------------------------------

/** Strip ANSI escape sequences to get the visual length of a string. */
function visLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Truncate a string to maxLen visual chars, appending ellipsis if cut. */
function truncate(s: string, maxLen: number): string {
  if (visLen(s) <= maxLen) return s;
  if (maxLen <= 1) return s.slice(0, maxLen);
  return s.slice(0, maxLen - 1) + '\u2026';
}

/** Pad a string to targetLen visual chars using the given alignment. */
function padCell(s: string, targetLen: number, align: Alignment): string {
  const vl = visLen(s);
  const space = Math.max(0, targetLen - vl);
  switch (align) {
    case 'right':
      return ' '.repeat(space) + s;
    case 'center': {
      const left = Math.floor(space / 2);
      const right = space - left;
      return ' '.repeat(left) + s + ' '.repeat(right);
    }
    default:
      return s + ' '.repeat(space);
  }
}

/** Apply a CellColor to a string. Returns the string unchanged for 'none'. */
function applyColor(s: string, color: CellColor | undefined): string {
  if (!color || color === 'none') return s;
  switch (color) {
    case 'cyan':   return `${A.cyan}${s}${A.reset}`;
    case 'yellow': return `${A.yellow}${s}${A.reset}`;
    case 'green':  return `${A.green}${s}${A.reset}`;
    case 'blue':   return `${A.blue}${s}${A.reset}`;
    case 'red':    return `${A.red}${s}${A.reset}`;
    case 'dim':    return `${A.dim}${s}${A.reset}`;
    case 'bold':   return `${A.bold}${s}${A.reset}`;
    default:       return s;
  }
}

// --- column inference ---------------------------------------------------------

function inferColumns(
  rows: (Record<string, unknown> | unknown[])[],
  defaultMaxWidth: number,
): ColumnDef[] {
  if (rows.length === 0) return [];
  const first = rows[0];
  if (Array.isArray(first)) {
    return (first as unknown[]).map((_, i) => ({
      header: String(i + 1),
      key: i,
      maxWidth: defaultMaxWidth,
    }));
  }
  return Object.keys(first as Record<string, unknown>).map(k => ({
    header: k,
    key: k,
    maxWidth: defaultMaxWidth,
  }));
}

// --- column width calculation -------------------------------------------------

function computeWidths(
  rows: (Record<string, unknown> | unknown[])[],
  columns: ColumnDef[],
  defaultMaxWidth: number,
): number[] {
  return columns.map(col => {
    const cap = col.maxWidth ?? defaultMaxWidth;
    const minW = col.minWidth ?? visLen(col.header);
    let max = minW;
    for (const row of rows) {
      const raw = Array.isArray(row)
        ? String((row as unknown[])[col.key as number] ?? '')
        : String((row as Record<string, unknown>)[col.key as string] ?? '');
      max = Math.max(max, Math.min(visLen(raw), cap));
    }
    return max;
  });
}

// --- border helpers -----------------------------------------------------------

function horizLine(
  widths: number[],
  padding: number,
  left: string,
  mid: string,
  right: string,
  horiz: string,
): string {
  const segments = widths.map(w => horiz.repeat(w + padding * 2));
  return left + segments.join(mid) + right;
}

// --- row builder --------------------------------------------------------------

function buildRow(
  cells: string[],
  widths: number[],
  columns: ColumnDef[],
  padding: number,
  vert: string,
  colorFn?: (col: ColumnDef, cell: string) => string,
): string {
  const parts = cells.map((cell, i) => {
    const col = columns[i];
    const align = col.align ?? 'left';
    const cap = col.maxWidth ?? Infinity;
    const truncated = truncate(cell, cap);
    const padded = padCell(truncated, widths[i], align);
    const colored = colorFn ? colorFn(col, padded) : padded;
    return ' '.repeat(padding) + colored + ' '.repeat(padding);
  });
  return vert + parts.join(vert) + vert;
}

// --- public API ---------------------------------------------------------------

/**
 * Render a table of data to ANSI-escaped terminal output using Unicode box-drawing.
 *
 * @param rows    - Array of objects or arrays. All rows must be the same shape.
 * @param options - Display options: columns, colors, compact mode, etc.
 * @returns       ANSI string ready to write to a terminal supporting ANSI escape codes.
 *
 * @example
 * const out = renderTable(
 *   [{ name: 'Eight', version: '1.0.0', status: 'live' }],
 *   { columns: [
 *     { header: 'Name',    key: 'name',    color: 'cyan' },
 *     { header: 'Version', key: 'version', align: 'right' },
 *     { header: 'Status',  key: 'status',  color: 'green' },
 *   ]}
 * );
 * process.stdout.write(out + '\n');
 */
export function renderTable(
  rows: (Record<string, unknown> | unknown[])[],
  options: TableOptions = {},
): string {
  const {
    compact = false,
    defaultMaxWidth = 40,
    padding = 1,
    rowSeparators = false,
    headerColor = 'bold',
    caption,
  } = options;

  const box = compact ? BOX_COMPACT : BOX_NORMAL;

  const columns = options.columns ?? inferColumns(rows, defaultMaxWidth);
  if (columns.length === 0) return '';

  const widths = computeWidths(rows, columns, defaultMaxWidth);
  const out: string[] = [];

  if (caption) {
    out.push(`${A.dim}${caption}${A.reset}`);
  }

  // Top border
  out.push(horizLine(widths, padding, box.topLeft, box.topMid, box.topRight, box.horiz));

  // Header row
  out.push(buildRow(
    columns.map(col => col.header),
    widths,
    columns,
    padding,
    box.vert,
    (_col, cell) => applyColor(cell, headerColor),
  ));

  // Header/data separator
  out.push(horizLine(widths, padding, box.midLeft, box.midMid, box.midRight, box.horiz));

  // Data rows
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells = columns.map(col => {
      return Array.isArray(row)
        ? String((row as unknown[])[col.key as number] ?? '')
        : String((row as Record<string, unknown>)[col.key as string] ?? '');
    });

    out.push(buildRow(
      cells,
      widths,
      columns,
      padding,
      box.vert,
      (col, cell) => applyColor(cell, col.color),
    ));

    if (rowSeparators && r < rows.length - 1) {
      out.push(horizLine(widths, padding, box.midLeft, box.midMid, box.midRight, box.horiz));
    }
  }

  // Bottom border
  out.push(horizLine(widths, padding, box.bottomLeft, box.bottomMid, box.bottomRight, box.horiz));

  return out.join('\n');
}
