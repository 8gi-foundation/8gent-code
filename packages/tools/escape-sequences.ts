/**
 * Terminal escape sequence generator.
 * Cursor movement, screen control, scroll regions, mouse tracking.
 * Zero dependencies. Works with any terminal that supports ANSI/VT100.
 */

const ESC = "\x1b";
const CSI = `${ESC}[`;

// --- Cursor ---

export const cursor = {
  up: (n = 1) => `${CSI}${n}A`,
  down: (n = 1) => `${CSI}${n}B`,
  right: (n = 1) => `${CSI}${n}C`,
  left: (n = 1) => `${CSI}${n}D`,

  /** Move to absolute position (1-based row, col). */
  position: (row: number, col: number) => `${CSI}${row};${col}H`,

  /** Move to column (1-based). */
  column: (col: number) => `${CSI}${col}G`,

  /** Move to start of line N lines up. */
  lineUp: (n = 1) => `${CSI}${n}F`,

  /** Move to start of line N lines down. */
  lineDown: (n = 1) => `${CSI}${n}E`,

  /** Save cursor position (DECSC). */
  save: () => `${ESC}7`,

  /** Restore cursor position (DECRC). */
  restore: () => `${ESC}8`,

  /** Hide cursor. */
  hide: () => `${CSI}?25l`,

  /** Show cursor. */
  show: () => `${CSI}?25h`,

  /** Report cursor position - terminal responds with ESC[row;colR. */
  report: () => `${CSI}6n`,

  /** Block cursor (steady). */
  blockSteady: () => `${CSI}2 q`,

  /** Underline cursor (steady). */
  underlineSteady: () => `${CSI}4 q`,

  /** Bar cursor (steady). */
  barSteady: () => `${CSI}6 q`,
};

// --- Screen ---

export const screen = {
  /** Clear from cursor to end of screen. */
  clearToEnd: () => `${CSI}0J`,

  /** Clear from cursor to beginning of screen. */
  clearToStart: () => `${CSI}1J`,

  /** Clear entire screen. */
  clear: () => `${CSI}2J`,

  /** Clear entire screen and scrollback buffer. */
  clearAll: () => `${CSI}3J`,

  /** Clear from cursor to end of line. */
  clearLineToEnd: () => `${CSI}0K`,

  /** Clear from cursor to start of line. */
  clearLineToStart: () => `${CSI}1K`,

  /** Clear entire line. */
  clearLine: () => `${CSI}2K`,

  /** Enter alternate screen buffer. */
  altEnter: () => `${CSI}?1049h`,

  /** Exit alternate screen buffer. */
  altExit: () => `${CSI}?1049l`,

  /** Set scroll region (1-based top/bottom rows). */
  scrollRegion: (top: number, bottom: number) => `${CSI}${top};${bottom}r`,

  /** Reset scroll region to full screen. */
  scrollRegionReset: () => `${CSI}r`,

  /** Scroll up N lines (within scroll region). */
  scrollUp: (n = 1) => `${CSI}${n}S`,

  /** Scroll down N lines (within scroll region). */
  scrollDown: (n = 1) => `${CSI}${n}T`,

  /** Insert N blank lines at cursor (pushes lines down). */
  insertLines: (n = 1) => `${CSI}${n}L`,

  /** Delete N lines at cursor (pulls lines up). */
  deleteLines: (n = 1) => `${CSI}${n}M`,

  /** Set window title (xterm). */
  title: (text: string) => `${ESC}]2;${text}\x07`,
};

// --- Style (SGR) ---

export const style = {
  reset: () => `${CSI}0m`,
  bold: () => `${CSI}1m`,
  dim: () => `${CSI}2m`,
  italic: () => `${CSI}3m`,
  underline: () => `${CSI}4m`,
  blink: () => `${CSI}5m`,
  inverse: () => `${CSI}7m`,
  hidden: () => `${CSI}8m`,
  strikethrough: () => `${CSI}9m`,

  /** Foreground: standard 16 colors (0-15). */
  fg16: (n: number) => n < 8 ? `${CSI}${30 + n}m` : `${CSI}${90 + n - 8}m`,

  /** Background: standard 16 colors (0-15). */
  bg16: (n: number) => n < 8 ? `${CSI}${40 + n}m` : `${CSI}${100 + n - 8}m`,

  /** Foreground: 256-color palette. */
  fg256: (n: number) => `${CSI}38;5;${n}m`,

  /** Background: 256-color palette. */
  bg256: (n: number) => `${CSI}48;5;${n}m`,

  /** Foreground: true-color RGB. */
  fgRgb: (r: number, g: number, b: number) => `${CSI}38;2;${r};${g};${b}m`,

  /** Background: true-color RGB. */
  bgRgb: (r: number, g: number, b: number) => `${CSI}48;2;${r};${g};${b}m`,

  /** Wrap text in SGR codes and reset after. */
  wrap: (codes: string, text: string) => `${codes}${text}${CSI}0m`,
};

// --- Mouse ---

export const mouse = {
  /** Enable X10 click reporting (button press only). */
  enableX10: () => `${CSI}?9h`,

  /** Enable normal mouse tracking (press + release). */
  enableNormal: () => `${CSI}?1000h`,

  /** Enable button-event tracking (drag). */
  enableButtonEvent: () => `${CSI}?1002h`,

  /** Enable all-motion tracking. */
  enableAllMotion: () => `${CSI}?1003h`,

  /** Disable all mouse tracking. */
  disable: () => `${CSI}?1000l`,

  /** Enable SGR extended mouse encoding (supports large terminals). */
  enableSgr: () => `${CSI}?1006h`,

  /** Disable SGR encoding. */
  disableSgr: () => `${CSI}?1006l`,
};
