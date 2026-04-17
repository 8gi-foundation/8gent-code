/**
 * CursorPosition - tracks cursor position in a text buffer with line/column awareness.
 *
 * Features:
 * - Bidirectional mapping: offset <-> { line, col }
 * - Tab-aware column calculation (configurable tab width)
 * - Surrounding context extraction (N lines before/after)
 * - Clamp to valid range
 */

export interface LineCol {
  /** 0-based line index */
  line: number;
  /** 0-based column index (visual, tab-expanded) */
  col: number;
  /** 0-based raw character column (no tab expansion) */
  rawCol: number;
}

export interface CursorContext {
  lineText: string;
  before: string[];
  after: string[];
  currentOffset: number;
  lineCol: LineCol;
}

const DEFAULT_TAB_WIDTH = 4;

/**
 * Convert a character offset to { line, col }.
 * col is tab-expanded visual column.
 */
export function offsetToLineCol(
  text: string,
  offset: number,
  tabWidth = DEFAULT_TAB_WIDTH
): LineCol {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  const lines = before.split("\n");
  const line = lines.length - 1;
  const rawLine = lines[line];
  const rawCol = rawLine.length;

  let col = 0;
  for (const ch of rawLine) {
    if (ch === "\t") {
      col = Math.floor(col / tabWidth) * tabWidth + tabWidth;
    } else {
      col++;
    }
  }

  return { line, col, rawCol };
}

/**
 * Convert { line, col } to a character offset.
 * col is raw character index (not tab-expanded).
 * Returns -1 if line/col is out of range.
 */
export function lineColToOffset(
  text: string,
  line: number,
  col: number
): number {
  const lines = text.split("\n");
  if (line < 0 || line >= lines.length) return -1;

  let offset = 0;
  for (let i = 0; i < line; i++) {
    offset += lines[i].length + 1; // +1 for \n
  }

  const lineLen = lines[line].length;
  const clampedCol = Math.max(0, Math.min(col, lineLen));
  return offset + clampedCol;
}

/**
 * CursorPosition - stateful cursor tracker over a mutable text buffer.
 */
export class CursorPosition {
  private _text: string;
  private _offset: number;
  private _tabWidth: number;

  constructor(text = "", offset = 0, tabWidth = DEFAULT_TAB_WIDTH) {
    this._text = text;
    this._tabWidth = tabWidth;
    this._offset = Math.max(0, Math.min(offset, text.length));
  }

  get text(): string {
    return this._text;
  }

  get offset(): number {
    return this._offset;
  }

  get lineCol(): LineCol {
    return offsetToLineCol(this._text, this._offset, this._tabWidth);
  }

  /** Update buffer text, clamping cursor to new length. */
  setText(text: string): this {
    this._text = text;
    this._offset = Math.min(this._offset, text.length);
    return this;
  }

  /** Move cursor to offset, clamped to [0, text.length]. */
  moveTo(offset: number): this {
    this._offset = Math.max(0, Math.min(offset, this._text.length));
    return this;
  }

  /** Move cursor to line/col (raw character column). */
  moveToLineCol(line: number, col: number): this {
    const off = lineColToOffset(this._text, line, col);
    if (off >= 0) this._offset = off;
    return this;
  }

  /**
   * Extract context around cursor.
   * @param radius - number of lines before and after to include
   */
  getContext(radius = 2): CursorContext {
    const { line } = this.lineCol;
    const lines = this._text.split("\n");
    const lineText = lines[line] ?? "";
    const before = lines.slice(Math.max(0, line - radius), line);
    const after = lines.slice(line + 1, line + 1 + radius);

    return {
      lineText,
      before,
      after,
      currentOffset: this._offset,
      lineCol: this.lineCol,
    };
  }
}
