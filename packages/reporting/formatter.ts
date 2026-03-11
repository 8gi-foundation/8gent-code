/**
 * 8gent Code - Terminal Formatter
 *
 * Beautiful terminal formatting utilities for reports.
 * Includes box drawing, tables, lists, and colors.
 */

// ============================================
// Color Constants
// ============================================

export const colors = {
  // Basic colors
  success: "\x1b[32m",     // green
  warning: "\x1b[33m",     // yellow
  error: "\x1b[31m",       // red
  info: "\x1b[36m",        // cyan
  muted: "\x1b[90m",       // gray
  white: "\x1b[37m",       // white
  magenta: "\x1b[35m",     // magenta
  blue: "\x1b[34m",        // blue

  // Bright variants
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightRed: "\x1b[91m",
  brightCyan: "\x1b[96m",
  brightMagenta: "\x1b[95m",
  brightBlue: "\x1b[94m",
  brightWhite: "\x1b[97m",

  // Formatting
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  strikethrough: "\x1b[9m",

  // Background colors
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
  bgCyan: "\x1b[46m",
  bgMagenta: "\x1b[45m",
  bgBlue: "\x1b[44m",
  bgWhite: "\x1b[47m",
  bgBlack: "\x1b[40m",
} as const;

// ============================================
// Unicode Box Drawing Characters
// ============================================

export const boxChars = {
  // Double line box
  doubleTopLeft: "\u2554",     // ╔
  doubleTopRight: "\u2557",    // ╗
  doubleBottomLeft: "\u255A",  // ╚
  doubleBottomRight: "\u255D", // ╝
  doubleHorizontal: "\u2550",  // ═
  doubleVertical: "\u2551",    // ║

  // Single line box
  singleTopLeft: "\u250C",     // ┌
  singleTopRight: "\u2510",    // ┐
  singleBottomLeft: "\u2514",  // └
  singleBottomRight: "\u2518", // ┘
  singleHorizontal: "\u2500",  // ─
  singleVertical: "\u2502",    // │

  // Round corners
  roundTopLeft: "\u256D",      // ╭
  roundTopRight: "\u256E",     // ╮
  roundBottomLeft: "\u2570",   // ╰
  roundBottomRight: "\u256F",  // ╯

  // Connectors
  teeRight: "\u251C",          // ├
  teeLeft: "\u2524",           // ┤
  teeDown: "\u252C",           // ┬
  teeUp: "\u2534",             // ┴
  cross: "\u253C",             // ┼

  // Tree characters
  treeMiddle: "\u251C",        // ├
  treeLast: "\u2514",          // └
  treeVertical: "\u2502",      // │

  // Symbols
  checkmark: "\u2713",         // ✓
  crossmark: "\u2717",         // ✗
  bullet: "\u2022",            // •
  arrow: "\u2192",             // →
  arrowRight: "\u25B8",        // ▸
  arrowDown: "\u25BE",         // ▾
  star: "\u2605",              // ★
  circle: "\u25CF",            // ●
  emptyCircle: "\u25CB",       // ○
  diamond: "\u25C6",           // ◆
  square: "\u25A0",            // ■
  emptySquare: "\u25A1",       // □
} as const;

// ============================================
// Color Helper Functions
// ============================================

export function colorize(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

export function bold(text: string): string {
  return `${colors.bold}${text}${colors.reset}`;
}

export function dim(text: string): string {
  return `${colors.dim}${text}${colors.reset}`;
}

export function success(text: string): string {
  return colorize(text, "success");
}

export function warning(text: string): string {
  return colorize(text, "warning");
}

export function error(text: string): string {
  return colorize(text, "error");
}

export function info(text: string): string {
  return colorize(text, "info");
}

export function muted(text: string): string {
  return colorize(text, "muted");
}

// ============================================
// Box Drawing Functions
// ============================================

export interface BoxOptions {
  style?: "double" | "single" | "round";
  title?: string;
  titleColor?: keyof typeof colors;
  borderColor?: keyof typeof colors;
  width?: number;
  padding?: number;
  align?: "left" | "center" | "right";
}

export function box(content: string, options: BoxOptions = {}): string {
  const {
    style = "double",
    title,
    titleColor = "info",
    borderColor = "muted",
    width = 64,
    padding = 1,
    align = "left",
  } = options;

  const chars = style === "double"
    ? {
        tl: boxChars.doubleTopLeft,
        tr: boxChars.doubleTopRight,
        bl: boxChars.doubleBottomLeft,
        br: boxChars.doubleBottomRight,
        h: boxChars.doubleHorizontal,
        v: boxChars.doubleVertical,
      }
    : style === "round"
    ? {
        tl: boxChars.roundTopLeft,
        tr: boxChars.roundTopRight,
        bl: boxChars.roundBottomLeft,
        br: boxChars.roundBottomRight,
        h: boxChars.singleHorizontal,
        v: boxChars.singleVertical,
      }
    : {
        tl: boxChars.singleTopLeft,
        tr: boxChars.singleTopRight,
        bl: boxChars.singleBottomLeft,
        br: boxChars.singleBottomRight,
        h: boxChars.singleHorizontal,
        v: boxChars.singleVertical,
      };

  const innerWidth = width - 2;
  const paddingStr = " ".repeat(padding);
  const contentWidth = innerWidth - padding * 2;

  // Build top border with optional title
  let topBorder: string;
  if (title) {
    const titleStr = ` ${title} `;
    const titleLen = stripAnsi(titleStr).length;
    const leftPad = Math.floor((innerWidth - titleLen) / 2);
    const rightPad = innerWidth - titleLen - leftPad;
    topBorder = colorize(chars.tl, borderColor) +
      colorize(chars.h.repeat(leftPad), borderColor) +
      colorize(titleStr, titleColor) +
      colorize(chars.h.repeat(rightPad), borderColor) +
      colorize(chars.tr, borderColor);
  } else {
    topBorder = colorize(chars.tl + chars.h.repeat(innerWidth) + chars.tr, borderColor);
  }

  // Build bottom border
  const bottomBorder = colorize(chars.bl + chars.h.repeat(innerWidth) + chars.br, borderColor);

  // Build content lines
  const lines = content.split("\n").flatMap(line => wrapText(line, contentWidth));
  const contentLines = lines.map(line => {
    const stripped = stripAnsi(line);
    const padNeeded = contentWidth - stripped.length;
    let paddedLine: string;

    if (align === "center") {
      const leftPad = Math.floor(padNeeded / 2);
      const rightPad = padNeeded - leftPad;
      paddedLine = " ".repeat(leftPad) + line + " ".repeat(rightPad);
    } else if (align === "right") {
      paddedLine = " ".repeat(padNeeded) + line;
    } else {
      paddedLine = line + " ".repeat(padNeeded);
    }

    return colorize(chars.v, borderColor) + paddingStr + paddedLine + paddingStr + colorize(chars.v, borderColor);
  });

  return [topBorder, ...contentLines, bottomBorder].join("\n");
}

// ============================================
// Table Functions
// ============================================

export interface TableOptions {
  headerColor?: keyof typeof colors;
  borderColor?: keyof typeof colors;
  columnWidths?: number[];
  align?: ("left" | "center" | "right")[];
}

export function table(headers: string[], rows: string[][], options: TableOptions = {}): string {
  const {
    headerColor = "info",
    borderColor = "muted",
    columnWidths,
    align = headers.map(() => "left"),
  } = options;

  // Calculate column widths
  const widths = columnWidths || headers.map((h, i) => {
    const headerLen = stripAnsi(h).length;
    const maxRowLen = Math.max(...rows.map(row => stripAnsi(row[i] || "").length));
    return Math.max(headerLen, maxRowLen) + 2;
  });

  const formatCell = (text: string, width: number, alignment: "left" | "center" | "right") => {
    const stripped = stripAnsi(text);
    const padNeeded = width - stripped.length;
    if (padNeeded <= 0) return text;

    if (alignment === "center") {
      const leftPad = Math.floor(padNeeded / 2);
      return " ".repeat(leftPad) + text + " ".repeat(padNeeded - leftPad);
    } else if (alignment === "right") {
      return " ".repeat(padNeeded) + text;
    }
    return text + " ".repeat(padNeeded);
  };

  const v = colorize(boxChars.singleVertical, borderColor);
  const h = colorize(boxChars.singleHorizontal, borderColor);

  // Top border
  const topBorder = colorize(boxChars.singleTopLeft, borderColor) +
    widths.map(w => h.repeat(w)).join(colorize(boxChars.teeDown, borderColor)) +
    colorize(boxChars.singleTopRight, borderColor);

  // Header row
  const headerRow = v +
    headers.map((h, i) => colorize(formatCell(h, widths[i], align[i]), headerColor)).join(v) +
    v;

  // Header separator
  const headerSep = colorize(boxChars.teeRight, borderColor) +
    widths.map(w => h.repeat(w)).join(colorize(boxChars.cross, borderColor)) +
    colorize(boxChars.teeLeft, borderColor);

  // Data rows
  const dataRows = rows.map(row =>
    v + row.map((cell, i) => formatCell(cell, widths[i], align[i])).join(v) + v
  );

  // Bottom border
  const bottomBorder = colorize(boxChars.singleBottomLeft, borderColor) +
    widths.map(w => h.repeat(w)).join(colorize(boxChars.teeUp, borderColor)) +
    colorize(boxChars.singleBottomRight, borderColor);

  return [topBorder, headerRow, headerSep, ...dataRows, bottomBorder].join("\n");
}

// ============================================
// List Functions
// ============================================

export interface ListOptions {
  bullet?: string;
  indent?: number;
  bulletColor?: keyof typeof colors;
}

export function list(items: string[], options: ListOptions = {}): string {
  const {
    bullet = boxChars.bullet,
    indent = 2,
    bulletColor = "info",
  } = options;

  const indentStr = " ".repeat(indent);
  return items
    .map(item => `${indentStr}${colorize(bullet, bulletColor)} ${item}`)
    .join("\n");
}

export function numberedList(items: string[], startIndex: number = 1): string {
  const maxNum = startIndex + items.length - 1;
  const numWidth = String(maxNum).length;

  return items
    .map((item, i) => {
      const num = String(startIndex + i).padStart(numWidth, " ");
      return `  ${muted(num + ".")} ${item}`;
    })
    .join("\n");
}

export function tree(items: TreeItem[], indent: number = 0): string {
  const lines: string[] = [];

  items.forEach((item, index) => {
    const isLast = index === items.length - 1;
    const prefix = " ".repeat(indent);
    const connector = isLast ? boxChars.treeLast : boxChars.treeMiddle;

    lines.push(`${prefix}${muted(connector + boxChars.singleHorizontal + boxChars.singleHorizontal)} ${item.label}`);

    if (item.children && item.children.length > 0) {
      const childPrefix = isLast ? "    " : boxChars.treeVertical + "   ";
      const childTree = tree(item.children, indent + 4);
      lines.push(childTree.replace(/^/gm, prefix + (isLast ? "    " : muted(boxChars.treeVertical) + "   ")));
    }
  });

  return lines.join("\n");
}

export interface TreeItem {
  label: string;
  children?: TreeItem[];
}

// ============================================
// Status Line Functions
// ============================================

export function statusLine(label: string, value: string, valueColor: keyof typeof colors = "white"): string {
  return `${muted(label + ":")} ${colorize(value, valueColor)}`;
}

export function keyValueLine(key: string, value: string, keyWidth: number = 20): string {
  const paddedKey = key.padEnd(keyWidth);
  return `${muted(paddedKey)} ${value}`;
}

// ============================================
// Divider Functions
// ============================================

export function divider(char: string = boxChars.singleHorizontal, width: number = 64, color: keyof typeof colors = "muted"): string {
  return colorize(char.repeat(width), color);
}

export function doubleDivider(width: number = 64): string {
  return colorize(boxChars.doubleHorizontal.repeat(width), "muted");
}

export function dashedDivider(width: number = 64): string {
  return muted("-".repeat(width));
}

// ============================================
// Heading Functions
// ============================================

export function heading(text: string, level: 1 | 2 | 3 = 1): string {
  switch (level) {
    case 1:
      return `\n${bold(colorize(text.toUpperCase(), "brightWhite"))}\n`;
    case 2:
      return `\n${bold(info(text))}\n`;
    case 3:
      return `\n${info(text)}\n`;
    default:
      return text;
  }
}

export function sectionHeader(text: string, width: number = 64): string {
  const padded = ` ${text} `;
  const totalPad = width - padded.length;
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;

  return muted("=".repeat(leftPad)) + bold(info(padded)) + muted("=".repeat(rightPad));
}

// ============================================
// Progress Indicators
// ============================================

export function progressBar(current: number, total: number, width: number = 40): string {
  const percentage = Math.min(100, Math.max(0, (current / total) * 100));
  const filled = Math.round((width * percentage) / 100);
  const empty = width - filled;

  const bar = success(boxChars.square.repeat(filled)) + muted(boxChars.emptySquare.repeat(empty));
  const pct = `${Math.round(percentage)}%`.padStart(4);

  return `${bar} ${muted(pct)}`;
}

export function spinner(frame: number): string {
  const frames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
  return info(frames[frame % frames.length]);
}

// ============================================
// Status Icons
// ============================================

export function statusIcon(status: "pass" | "fail" | "pending" | "skipped" | "running"): string {
  switch (status) {
    case "pass":
      return success(boxChars.checkmark);
    case "fail":
      return error(boxChars.crossmark);
    case "pending":
      return muted(boxChars.emptyCircle);
    case "skipped":
      return warning("-");
    case "running":
      return info(boxChars.arrowRight);
    default:
      return muted("?");
  }
}

export function stepIcon(status: "pending" | "running" | "completed" | "failed" | "skipped"): string {
  switch (status) {
    case "completed":
      return success(boxChars.checkmark);
    case "failed":
      return error(boxChars.crossmark);
    case "running":
      return info(boxChars.arrowRight);
    case "skipped":
      return warning("-");
    case "pending":
    default:
      return muted(boxChars.emptyCircle);
  }
}

// ============================================
// Utility Functions
// ============================================

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function wrapText(text: string, maxWidth: number): string[] {
  if (stripAnsi(text).length <= maxWidth) {
    return [text];
  }

  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (stripAnsi(testLine).length <= maxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

export function truncate(text: string, maxLength: number, suffix: string = "..."): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= maxLength) {
    return text;
  }
  return stripped.slice(0, maxLength - suffix.length) + suffix;
}

export function padCenter(text: string, width: number): string {
  const stripped = stripAnsi(text);
  const padNeeded = width - stripped.length;
  if (padNeeded <= 0) return text;
  const leftPad = Math.floor(padNeeded / 2);
  return " ".repeat(leftPad) + text + " ".repeat(padNeeded - leftPad);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
}

export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K";
  }
  return num.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
