/**
 * StringBuilder - efficient string concatenation with lazy evaluation
 *
 * Avoids the O(n^2) string concatenation problem by collecting parts
 * in an array and joining only on toString(). Supports indentation
 * management for code generation use cases.
 */

export class StringBuilder {
  private parts: string[] = [];
  private _indentLevel: number = 0;
  private _indentStr: string = "  ";
  private _dirty: boolean = false;
  private _cache: string = "";

  constructor(initial?: string) {
    if (initial !== undefined) {
      this.parts.push(initial);
    }
  }

  /** Append a string to the end */
  append(value: string): this {
    this.parts.push(value);
    this._dirty = true;
    return this;
  }

  /** Prepend a string to the beginning */
  prepend(value: string): this {
    this.parts.unshift(value);
    this._dirty = true;
    return this;
  }

  /** Append a string followed by a newline, with current indentation applied */
  appendLine(value: string = ""): this {
    if (value === "") {
      this.parts.push("\n");
    } else {
      this.parts.push(this._indentStr.repeat(this._indentLevel) + value + "\n");
    }
    this._dirty = true;
    return this;
  }

  /** Insert a blank line (just a newline) */
  blankLine(): this {
    return this.appendLine();
  }

  /** Increase indent level by 1 */
  indent(): this {
    this._indentLevel++;
    return this;
  }

  /** Decrease indent level by 1 (floor at 0) */
  dedent(): this {
    if (this._indentLevel > 0) this._indentLevel--;
    return this;
  }

  /** Set the indent string (default: two spaces) */
  setIndentString(str: string): this {
    this._indentStr = str;
    return this;
  }

  /** Run a callback at increased indent, then restore */
  block(fn: (sb: this) => void): this {
    this.indent();
    fn(this);
    this.dedent();
    return this;
  }

  /** Return total character count across all parts (O(n) scan, not cached) */
  get length(): number {
    return this.parts.reduce((acc, p) => acc + p.length, 0);
  }

  /** Return number of parts collected (useful for debugging) */
  get partCount(): number {
    return this.parts.length;
  }

  /** Current indent level */
  get indentLevel(): number {
    return this._indentLevel;
  }

  /** Clear all content and reset indent */
  clear(): this {
    this.parts = [];
    this._indentLevel = 0;
    this._cache = "";
    this._dirty = false;
    return this;
  }

  /** Lazy join - only joins when content has changed since last call */
  toString(): string {
    if (!this._dirty && this._cache !== undefined) {
      return this._cache;
    }
    this._cache = this.parts.join("");
    this._dirty = false;
    return this._cache;
  }

  /** Alias for toString, useful when passing to APIs expecting a string */
  valueOf(): string {
    return this.toString();
  }

  /** Create a StringBuilder from an array of lines */
  static fromLines(lines: string[]): StringBuilder {
    const sb = new StringBuilder();
    for (const line of lines) {
      sb.appendLine(line);
    }
    return sb;
  }

  /** Create a StringBuilder with a given indent string */
  static withIndent(indentStr: string): StringBuilder {
    return new StringBuilder().setIndentString(indentStr);
  }
}
