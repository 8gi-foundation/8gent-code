/**
 * consoleTable - improved console.table with alignment, ANSI colors, row striping,
 * compact mode, and markdown output.
 */

export interface ConsoleTableOptions {
  /** Max width per column (chars). Default: 40 */
  maxColWidth?: number;
  /** Highlight header row with ANSI bold+color. Default: true */
  headerColors?: boolean;
  /** Alternate row background via ANSI dim. Default: true */
  rowStriping?: boolean;
  /** Remove padding between columns. Default: false */
  compact?: boolean;
  /** Emit GitHub-flavored markdown table instead of ANSI. Default: false */
  markdown?: boolean;
  /** Columns to include (in order). Default: all detected */
  columns?: string[];
  /** Per-column alignment override. Default: auto (numbers right, strings left) */
  align?: Record<string, 'left' | 'right' | 'center'>;
}

type Row = Record<string, unknown>;

// ANSI helpers
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';

function ansi(text: string, ...codes: string[]): string {
  return codes.join('') + text + RESET;
}

function isNumeric(val: unknown): boolean {
  if (val === null || val === undefined || val === '') return false;
  return !isNaN(Number(val));
}

function stringify(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function pad(text: string, width: number, alignment: 'left' | 'right' | 'center'): string {
  const len = text.length;
  if (len >= width) return text;
  const diff = width - len;
  if (alignment === 'right') return ' '.repeat(diff) + text;
  if (alignment === 'center') {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return ' '.repeat(left) + text + ' '.repeat(right);
  }
  return text + ' '.repeat(diff);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

function detectColumns(data: Row[]): string[] {
  const seen = new Set<string>();
  for (const row of data) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return [...seen];
}

function detectAlign(col: string, data: Row[]): 'left' | 'right' {
  for (const row of data) {
    if (!isNumeric(row[col])) return 'left';
  }
  return 'right';
}

function buildMarkdown(
  columns: string[],
  rows: string[][],
  aligns: ('left' | 'right' | 'center')[],
  widths: number[]
): string {
  const sep = aligns.map((a, i) => {
    const dashes = '-'.repeat(widths[i]);
    if (a === 'right') return '-'.repeat(widths[i] - 1) + ':';
    if (a === 'center') return ':' + '-'.repeat(widths[i] - 2) + ':';
    return dashes;
  });

  const header = '| ' + columns.map((c, i) => pad(c, widths[i], aligns[i])).join(' | ') + ' |';
  const divider = '| ' + sep.join(' | ') + ' |';
  const body = rows.map(row => '| ' + row.map((cell, i) => pad(cell, widths[i], aligns[i])).join(' | ') + ' |');

  return [header, divider, ...body].join('\n');
}

function buildAnsi(
  columns: string[],
  rows: string[][],
  aligns: ('left' | 'right' | 'center')[],
  widths: number[],
  opts: Required<Pick<ConsoleTableOptions, 'headerColors' | 'rowStriping' | 'compact'>>
): string {
  const gap = opts.compact ? '' : ' ';
  const sep = opts.compact ? '|' : ' | ';

  const headerCells = columns.map((c, i) => {
    const cell = pad(c, widths[i], aligns[i]);
    return opts.headerColors ? ansi(cell, BOLD, CYAN) : cell;
  });
  const headerLine = gap + headerCells.join(sep) + gap;

  const divider = gap + widths.map(w => '-'.repeat(w)).join(opts.compact ? '+' : '-+-') + gap;

  const bodyLines = rows.map((row, rowIdx) => {
    const cells = row.map((cell, i) => pad(cell, widths[i], aligns[i]));
    const line = gap + cells.join(sep) + gap;
    return opts.rowStriping && rowIdx % 2 === 1 ? ansi(line, DIM) : line;
  });

  return [headerLine, divider, ...bodyLines].join('\n');
}

/**
 * Render an array of objects as a formatted table.
 *
 * @param data - Array of plain objects (all should share keys)
 * @param options - Formatting options
 * @returns Formatted table string (print with console.log)
 */
export function consoleTable(data: Row[], options: ConsoleTableOptions = {}): string {
  if (!Array.isArray(data) || data.length === 0) return '(empty)';

  const maxColWidth = options.maxColWidth ?? 40;
  const headerColors = options.headerColors ?? true;
  const rowStriping = options.rowStriping ?? true;
  const compact = options.compact ?? false;
  const markdown = options.markdown ?? false;

  const columns = options.columns ?? detectColumns(data);

  const aligns: ('left' | 'right' | 'center')[] = columns.map(col => {
    return options.align?.[col] ?? detectAlign(col, data);
  });

  // Build raw cell strings
  const rawRows: string[][] = data.map(row =>
    columns.map(col => truncate(stringify(row[col]), maxColWidth))
  );

  // Compute column widths
  const widths: number[] = columns.map((col, i) => {
    const headerLen = col.length;
    const maxData = Math.max(0, ...rawRows.map(r => r[i].length));
    return Math.max(headerLen, maxData);
  });

  if (markdown) {
    return buildMarkdown(columns, rawRows, aligns, widths);
  }

  return buildAnsi(columns, rawRows, aligns, widths, { headerColors, rowStriping, compact });
}

/** Convenience: print directly to stdout */
export function printTable(data: Row[], options: ConsoleTableOptions = {}): void {
  console.log(consoleTable(data, options));
}
