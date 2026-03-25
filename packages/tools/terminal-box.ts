/**
 * terminal-box: draws Unicode box borders around text content.
 * Self-contained, zero dependencies beyond Node/Bun built-ins.
 */

export type BoxStyle = 'single' | 'double' | 'round' | 'bold' | 'ascii';
export type TitleAlignment = 'left' | 'center' | 'right';

export interface BoxOptions {
  style?: BoxStyle;
  padding?: number | { x?: number; y?: number };
  margin?: number | { x?: number; y?: number };
  title?: string;
  titleAlignment?: TitleAlignment;
  borderColor?: string;
  width?: number;
}

interface BoxChars {
  topLeft: string; topRight: string;
  bottomLeft: string; bottomRight: string;
  top: string; bottom: string;
  left: string; right: string;
}

const STYLES: Record<BoxStyle, BoxChars> = {
  single: {
    topLeft: '\u250c', topRight: '\u2510',
    bottomLeft: '\u2514', bottomRight: '\u2518',
    top: '\u2500', bottom: '\u2500',
    left: '\u2502', right: '\u2502',
  },
  double: {
    topLeft: '\u2554', topRight: '\u2557',
    bottomLeft: '\u255a', bottomRight: '\u255d',
    top: '\u2550', bottom: '\u2550',
    left: '\u2551', right: '\u2551',
  },
  round: {
    topLeft: '\u256d', topRight: '\u256e',
    bottomLeft: '\u2570', bottomRight: '\u256f',
    top: '\u2500', bottom: '\u2500',
    left: '\u2502', right: '\u2502',
  },
  bold: {
    topLeft: '\u250f', topRight: '\u2513',
    bottomLeft: '\u2517', bottomRight: '\u251b',
    top: '\u2501', bottom: '\u2501',
    left: '\u2503', right: '\u2503',
  },
  ascii: {
    topLeft: '+', topRight: '+',
    bottomLeft: '+', bottomRight: '+',
    top: '-', bottom: '-',
    left: '|', right: '|',
  },
};

const ANSI_COLORS: Record<string, string> = {
  black: '\x1b[30m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m',
  cyan: '\x1b[36m', white: '\x1b[37m', reset: '\x1b[0m',
};

function colorize(text: string, color?: string): string {
  if (!color || !ANSI_COLORS[color]) return text;
  return `${ANSI_COLORS[color]}${text}${ANSI_COLORS.reset}`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function padEnd(text: string, targetLen: number): string {
  const visible = visibleLength(text);
  return text + ' '.repeat(Math.max(0, targetLen - visible));
}

function resolveSpacing(val: number | { x?: number; y?: number } | undefined, axis: 'x' | 'y'): number {
  if (val === undefined) return 0;
  if (typeof val === 'number') return val;
  return val[axis] ?? 0;
}

function buildTitleTop(title: string, innerWidth: number, align: TitleAlignment, chars: BoxChars, color?: string): string {
  const maxTitle = innerWidth - 2;
  const clipped = title.length > maxTitle ? title.slice(0, maxTitle) : title;
  const remaining = innerWidth - clipped.length;
  let topFill: string;
  if (align === 'center') {
    const left = Math.floor(remaining / 2);
    topFill = chars.top.repeat(left) + clipped + chars.top.repeat(remaining - left);
  } else if (align === 'right') {
    topFill = chars.top.repeat(remaining) + clipped;
  } else {
    topFill = clipped + chars.top.repeat(remaining);
  }
  return colorize(chars.topLeft + topFill + chars.topRight, color);
}

/**
 * Draws a Unicode box around the provided text.
 *
 * @param text - Content to wrap. Multi-line strings are supported.
 * @param options - Style, padding, margin, title, alignment, color.
 * @returns The rendered box as a string ready to print.
 *
 * @example
 * console.log(box('Hello!', { style: 'double', title: 'Status', borderColor: 'cyan' }));
 */
export function box(text: string, options: BoxOptions = {}): string {
  const { style = 'single', title, titleAlignment = 'left', borderColor, width } = options;

  const padX = resolveSpacing(options.padding, 'x') !== 0 ? resolveSpacing(options.padding, 'x') : 1;
  const padY = resolveSpacing(options.padding, 'y');
  const marginX = resolveSpacing(options.margin, 'x');
  const marginY = resolveSpacing(options.margin, 'y');

  const chars = STYLES[style];
  const lines = text.split('\n');
  const contentWidth = width
    ? width - 2 - padX * 2
    : Math.max(...lines.map(l => visibleLength(l)));
  const innerWidth = contentWidth + padX * 2;

  const hMargin = ' '.repeat(marginX);
  const output: string[] = [];

  for (let i = 0; i < marginY; i++) output.push('');

  output.push(
    hMargin + (title
      ? buildTitleTop(title, innerWidth, titleAlignment, chars, borderColor)
      : colorize(chars.topLeft + chars.top.repeat(innerWidth) + chars.topRight, borderColor))
  );

  for (let i = 0; i < padY; i++) {
    output.push(hMargin + colorize(chars.left, borderColor) + ' '.repeat(innerWidth) + colorize(chars.right, borderColor));
  }

  for (const line of lines) {
    const cell = ' '.repeat(padX) + padEnd(line, contentWidth) + ' '.repeat(padX);
    output.push(hMargin + colorize(chars.left, borderColor) + cell + colorize(chars.right, borderColor));
  }

  for (let i = 0; i < padY; i++) {
    output.push(hMargin + colorize(chars.left, borderColor) + ' '.repeat(innerWidth) + colorize(chars.right, borderColor));
  }

  output.push(hMargin + colorize(chars.bottomLeft + chars.bottom.repeat(innerWidth) + chars.bottomRight, borderColor));

  for (let i = 0; i < marginY; i++) output.push('');

  return output.join('\n');
}
