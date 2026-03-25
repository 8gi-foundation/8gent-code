/**
 * Raw ANSI escape code open/close pairs for terminal styling.
 *
 * Usage:
 *   import { styles, apply } from './ansi-styles';
 *   console.log(apply('hello', styles.bold));
 *   console.log(apply('hello', styles.fg.red));
 *   console.log(apply('hello', styles.color256(214)));
 *   console.log(apply('hello', styles.rgb(255, 128, 0)));
 */

export interface AnsiPair {
  open: string;
  close: string;
}

function esc(open: number, close: number): AnsiPair {
  return { open: `\x1b[${open}m`, close: `\x1b[${close}m` };
}

// Text style open/close pairs
const text: Record<string, AnsiPair> = {
  bold:          esc(1, 22),
  dim:           esc(2, 22),
  italic:        esc(3, 23),
  underline:     esc(4, 24),
  blink:         esc(5, 25),
  inverse:       esc(7, 27),
  hidden:        esc(8, 28),
  strikethrough: esc(9, 29),
  overline:      esc(53, 55),
};

// Standard foreground colors (8 normal + 8 bright)
const fg: Record<string, AnsiPair> = {
  black:         esc(30, 39),
  red:           esc(31, 39),
  green:         esc(32, 39),
  yellow:        esc(33, 39),
  blue:          esc(34, 39),
  magenta:       esc(35, 39),
  cyan:          esc(36, 39),
  white:         esc(37, 39),
  blackBright:   esc(90, 39),
  redBright:     esc(91, 39),
  greenBright:   esc(92, 39),
  yellowBright:  esc(93, 39),
  blueBright:    esc(94, 39),
  magentaBright: esc(95, 39),
  cyanBright:    esc(96, 39),
  whiteBright:   esc(97, 39),
};

// Standard background colors (8 normal + 8 bright)
const bg: Record<string, AnsiPair> = {
  black:         esc(40, 49),
  red:           esc(41, 49),
  green:         esc(42, 49),
  yellow:        esc(43, 49),
  blue:          esc(44, 49),
  magenta:       esc(45, 49),
  cyan:          esc(46, 49),
  white:         esc(47, 49),
  blackBright:   esc(100, 49),
  redBright:     esc(101, 49),
  greenBright:   esc(102, 49),
  yellowBright:  esc(103, 49),
  blueBright:    esc(104, 49),
  magentaBright: esc(105, 49),
  cyanBright:    esc(106, 49),
  whiteBright:   esc(107, 49),
};

// Reset all styles
const reset: AnsiPair = esc(0, 0);

/**
 * 256-color foreground. n = 0-255.
 */
function color256(n: number): AnsiPair {
  return {
    open:  `\x1b[38;5;${n}m`,
    close: `\x1b[39m`,
  };
}

/**
 * 256-color background. n = 0-255.
 */
function bgColor256(n: number): AnsiPair {
  return {
    open:  `\x1b[48;5;${n}m`,
    close: `\x1b[49m`,
  };
}

/**
 * 24-bit RGB foreground. r, g, b = 0-255.
 */
function rgb(r: number, g: number, b: number): AnsiPair {
  return {
    open:  `\x1b[38;2;${r};${g};${b}m`,
    close: `\x1b[39m`,
  };
}

/**
 * 24-bit RGB background. r, g, b = 0-255.
 */
function bgRgb(r: number, g: number, b: number): AnsiPair {
  return {
    open:  `\x1b[48;2;${r};${g};${b}m`,
    close: `\x1b[49m`,
  };
}

/**
 * Wrap text with an ANSI style pair.
 * Nesting-safe: restores close code after text.
 */
export function apply(text: string, style: AnsiPair): string {
  return `${style.open}${text}${style.close}`;
}

/**
 * Apply multiple styles in order (outermost first).
 */
export function applyAll(text: string, ...styleList: AnsiPair[]): string {
  return styleList.reduceRight((acc, style) => apply(acc, style), text);
}

export const styles = {
  ...text,
  fg,
  bg,
  reset,
  color256,
  bgColor256,
  rgb,
  bgRgb,
} as const;

export default styles;
