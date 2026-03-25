/**
 * ANSI escape code stripper and visible width calculator.
 *
 * Strips color/style codes from terminal strings, measures visible character
 * width (accounting for wide CJK characters and zero-width sequences), and
 * provides helpers for TUI layout calculations.
 *
 * Zero runtime dependencies.
 */

// Matches all ANSI/VT100 escape sequences:
//   ESC [ ... m   - SGR (colors, bold, underline, etc.)
//   ESC [ ... H/A/B/etc - cursor movement
//   ESC ] ... ST  - OSC sequences (hyperlinks, window title)
//   ESC ( ...     - character set designation
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B](?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[\u001B\u009B]\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

/**
 * Strips all ANSI escape codes from a string.
 * Returns the plain visible text.
 *
 * @example
 * stripAnsi('\x1b[32mhello\x1b[0m') // 'hello'
 */
export function stripAnsi(str: string): string {
  if (typeof str !== "string") return str;
  return str.replace(ANSI_PATTERN, "");
}

/**
 * Returns true if the string contains any ANSI escape sequences.
 *
 * @example
 * hasAnsi('\x1b[32mhello\x1b[0m') // true
 * hasAnsi('plain text')            // false
 */
export function hasAnsi(str: string): boolean {
  if (typeof str !== "string") return false;
  ANSI_PATTERN.lastIndex = 0;
  return ANSI_PATTERN.test(str);
}

/**
 * Returns the visible (rendered) width of a string in terminal columns.
 * Strips ANSI codes, then accounts for:
 *   - Wide (CJK) characters that occupy 2 columns
 *   - Zero-width characters (combining marks, ZWJ, etc.) that occupy 0 columns
 *
 * @example
 * visibleWidth('\x1b[32mhello\x1b[0m') // 5
 * visibleWidth('你好')                  // 4  (each CJK char = 2 cols)
 */
export function visibleWidth(str: string): number {
  if (typeof str !== "string") return 0;
  const plain = stripAnsi(str);
  let width = 0;
  for (const char of plain) {
    width += charWidth(char);
  }
  return width;
}

/**
 * Returns the column width of a single Unicode character.
 *   0 - zero-width (combining marks, ZWJ, null, etc.)
 *   1 - standard width
 *   2 - wide (CJK ideographs, fullwidth forms, emoji with wide presentation)
 */
export function charWidth(char: string): 0 | 1 | 2 {
  const cp = char.codePointAt(0);
  if (cp === undefined) return 0;

  // Null and C0/C1 controls
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;

  // Combining / zero-width marks
  if (isZeroWidth(cp)) return 0;

  // Wide character ranges (CJK, fullwidth, emoji wide)
  if (isWide(cp)) return 2;

  return 1;
}

/**
 * Truncates a string to fit within `maxWidth` terminal columns.
 * Preserves ANSI codes by tracking visible width separately.
 * Appends `ellipsis` (default "...") if truncation occurs.
 *
 * @example
 * truncateAnsi('\x1b[32mhello world\x1b[0m', 8) // '\x1b[32mhello\x1b[0m...'
 */
export function truncateAnsi(
  str: string,
  maxWidth: number,
  ellipsis = "..."
): string {
  if (visibleWidth(str) <= maxWidth) return str;
  const ellipsisWidth = visibleWidth(ellipsis);
  const budget = maxWidth - ellipsisWidth;
  if (budget <= 0) return ellipsis.slice(0, maxWidth);

  let visible = 0;
  let result = "";
  // Walk through the string preserving escape sequences
  const tokenPattern =
    // eslint-disable-next-line no-control-regex
    /([\u001B\u009B](?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|[\u001B\u009B]\][^\u0007\u001B]*(?:\u0007|\u001B\\))|([\s\S])/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(str)) !== null) {
    if (match[1]) {
      // ANSI sequence - include without counting width
      result += match[1];
    } else {
      const w = charWidth(match[2]);
      if (visible + w > budget) break;
      visible += w;
      result += match[2];
    }
  }
  return result + ellipsis;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isZeroWidth(cp: number): boolean {
  // Combining diacritical marks and similar zero-width ranges
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) || // Combining Diacritical Marks Supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
    cp === 0x200b || // ZWSP
    cp === 0x200c || // ZWNJ
    cp === 0x200d || // ZWJ
    cp === 0xfeff || // BOM / ZWNBSP
    (cp >= 0xfe00 && cp <= 0xfe0f) // Variation Selectors
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals + Kangxi + misc
    (cp >= 0x3040 && cp <= 0x33ff) || // Hiragana, Katakana, Bopomofo, etc.
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xa960 && cp <= 0xa97f) || // Hangul Jamo Extended-A
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical Forms
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b0ff) || // Kana Supplement
    (cp >= 0x1f004 && cp <= 0x1f0cf) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Miscellaneous Symbols and Pictographs
    (cp >= 0x1f900 && cp <= 0x1f9ff) || // Supplemental Symbols and Pictographs
    (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Unified Ideographs Extension B
    (cp >= 0x2a700 && cp <= 0x2ceaf) ||
    (cp >= 0x2ceb0 && cp <= 0x2ebef) ||
    (cp >= 0x30000 && cp <= 0x3134f)
  );
}
