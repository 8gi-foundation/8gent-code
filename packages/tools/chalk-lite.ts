/**
 * chalk-lite - minimal chainable terminal color library
 * Self-contained, zero-dependency. ~130 lines.
 * Supports: 16 named colors, 256 colors, RGB, bold, dim, underline, inverse, strikethrough.
 */

// ANSI escape sequences
const ESC = '\x1b[';

type AnsiCode = [number, number]; // [open, close]

const CODES: Record<string, AnsiCode> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  strikethrough: [9, 29],
  black: [30, 39],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  white: [37, 39],
  blackBright: [90, 39],
  redBright: [91, 39],
  greenBright: [92, 39],
  yellowBright: [93, 39],
  blueBright: [94, 39],
  magentaBright: [95, 39],
  cyanBright: [96, 39],
  whiteBright: [97, 39],
  bgBlack: [40, 49],
  bgRed: [41, 49],
  bgGreen: [42, 49],
  bgYellow: [43, 49],
  bgBlue: [44, 49],
  bgMagenta: [45, 49],
  bgCyan: [46, 49],
  bgWhite: [47, 49],
};

/** Detect color support: 0=none, 1=16colors, 2=256colors, 3=truecolor */
function detectColorSupport(): 0 | 1 | 2 | 3 {
  if (typeof process === 'undefined') return 0;
  if (process.env.NO_COLOR !== undefined) return 0;
  if (process.env.FORCE_COLOR) {
    const level = parseInt(process.env.FORCE_COLOR, 10);
    if (level >= 3) return 3;
    if (level >= 2) return 2;
    return 1;
  }
  if (!process.stdout?.isTTY) return 0;
  const term = process.env.TERM ?? '';
  const colorterm = (process.env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  if (term.includes('256color') || colorterm === '256color') return 2;
  if (term === 'dumb') return 0;
  return 1;
}

const COLOR_LEVEL = detectColorSupport();

/** Convert RGB to nearest xterm-256 color index */
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }
  return 16 + 36 * Math.round(r / 255 * 5) + 6 * Math.round(g / 255 * 5) + Math.round(b / 255 * 5);
}

class ChalkBuilder {
  protected _opens: string[] = [];
  protected _closes: string[] = [];

  private _clone(open: string, close: string): ChalkBuilder {
    const b = new ChalkBuilder();
    b._opens = [...this._opens, open];
    b._closes = [close, ...this._closes];
    return b;
  }

  _named(key: string): ChalkBuilder {
    const code = CODES[key];
    if (!code) throw new Error(`chalk-lite: unknown modifier "${key}"`);
    return this._clone(`${ESC}${code[0]}m`, `${ESC}${code[1]}m`);
  }

  rgb(r: number, g: number, b: number): ChalkBuilder {
    if (COLOR_LEVEL >= 3) return this._clone(`${ESC}38;2;${r};${g};${b}m`, `${ESC}39m`);
    return this._clone(`${ESC}38;5;${rgbTo256(r, g, b)}m`, `${ESC}39m`);
  }

  bgRgb(r: number, g: number, b: number): ChalkBuilder {
    if (COLOR_LEVEL >= 3) return this._clone(`${ESC}48;2;${r};${g};${b}m`, `${ESC}49m`);
    return this._clone(`${ESC}48;5;${rgbTo256(r, g, b)}m`, `${ESC}49m`);
  }

  ansi256(n: number): ChalkBuilder {
    return this._clone(`${ESC}38;5;${n}m`, `${ESC}39m`);
  }

  bgAnsi256(n: number): ChalkBuilder {
    return this._clone(`${ESC}48;5;${n}m`, `${ESC}49m`);
  }

  call(text: string): string {
    if (COLOR_LEVEL === 0) return text;
    return this._opens.join('') + text + this._closes.join('');
  }
}

function makeProxy(builder: ChalkBuilder): any {
  return new Proxy(builder, {
    get(target, prop: string) {
      if (prop === 'rgb' || prop === 'bgRgb' || prop === 'ansi256' || prop === 'bgAnsi256') {
        return (...args: number[]) => makeProxy((target as any)[prop](...args));
      }
      if (prop in CODES) return makeProxy(target._named(prop));
      return undefined;
    },
    apply(target, _thisArg, args) {
      return target.call(String(args[0] ?? ''));
    },
  });
}

export const chalk = makeProxy(new ChalkBuilder()) as ChalkLite;
export const colorLevel = COLOR_LEVEL;

export type ChalkLite = {
  (text: string): string;
  bold: ChalkLite; dim: ChalkLite; italic: ChalkLite; underline: ChalkLite;
  inverse: ChalkLite; strikethrough: ChalkLite;
  black: ChalkLite; red: ChalkLite; green: ChalkLite; yellow: ChalkLite;
  blue: ChalkLite; magenta: ChalkLite; cyan: ChalkLite; white: ChalkLite;
  blackBright: ChalkLite; redBright: ChalkLite; greenBright: ChalkLite;
  yellowBright: ChalkLite; blueBright: ChalkLite; magentaBright: ChalkLite;
  cyanBright: ChalkLite; whiteBright: ChalkLite;
  bgBlack: ChalkLite; bgRed: ChalkLite; bgGreen: ChalkLite; bgYellow: ChalkLite;
  bgBlue: ChalkLite; bgMagenta: ChalkLite; bgCyan: ChalkLite; bgWhite: ChalkLite;
  rgb(r: number, g: number, b: number): ChalkLite;
  bgRgb(r: number, g: number, b: number): ChalkLite;
  ansi256(n: number): ChalkLite;
  bgAnsi256(n: number): ChalkLite;
};

export default chalk;
