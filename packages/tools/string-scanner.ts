/**
 * Cursor-based string scanner for building parsers.
 * Inspired by Ruby's StringScanner - advance through a string matching patterns.
 */

export class StringScanner {
  private _source: string;
  private _pos: number;
  private _matched: string | null;
  private _lastMatchPos: number;

  constructor(source: string) {
    this._source = source;
    this._pos = 0;
    this._matched = null;
    this._lastMatchPos = 0;
  }

  /** Current cursor position (index into source string). */
  get position(): number {
    return this._pos;
  }

  /** The last string matched by scan() or advance(). Null if no match yet. */
  get matched(): string | null {
    return this._matched;
  }

  /** True if the cursor is at the end of the source string. */
  get eos(): boolean {
    return this._pos >= this._source.length;
  }

  /** The remaining (unscanned) portion of the source string. */
  get rest(): string {
    return this._source.slice(this._pos);
  }

  /**
   * Try to match pattern at the current position.
   * If it matches, advance the cursor past the match and return the matched string.
   * Returns null on no match.
   */
  scan(pattern: RegExp | string): string | null {
    const re = this._toAnchored(pattern);
    const result = re.exec(this._source.slice(this._pos));
    if (result === null) {
      this._matched = null;
      return null;
    }
    this._matched = result[0];
    this._lastMatchPos = this._pos;
    this._pos += this._matched.length;
    return this._matched;
  }

  /**
   * Check if pattern matches at the current position without advancing.
   * Returns the matched string on success, null on failure.
   * Does not update this.matched.
   */
  check(pattern: RegExp | string): string | null {
    const re = this._toAnchored(pattern);
    const result = re.exec(this._source.slice(this._pos));
    if (result === null) return null;
    return result[0];
  }

  /**
   * Advance the cursor by n characters (default 1).
   * Returns the skipped string, or null if already at end.
   */
  advance(n: number = 1): string | null {
    if (this.eos) return null;
    const skipped = this._source.slice(this._pos, this._pos + n);
    this._matched = skipped;
    this._pos = Math.min(this._pos + n, this._source.length);
    return skipped;
  }

  /**
   * Peek at the next n characters without advancing (default 1).
   * Returns an empty string if at end.
   */
  peek(n: number = 1): string {
    return this._source.slice(this._pos, this._pos + n);
  }

  /**
   * Advance up to (not including) the next match of pattern.
   * Returns the skipped portion, or null if pattern not found.
   */
  scanUntil(pattern: RegExp | string): string | null {
    const re = this._toUnanchored(pattern);
    const remaining = this._source.slice(this._pos);
    const result = re.exec(remaining);
    if (result === null) return null;
    const skipped = remaining.slice(0, result.index);
    this._matched = skipped;
    this._lastMatchPos = this._pos;
    this._pos += result.index;
    return skipped;
  }

  /**
   * Reset the cursor to pos (default 0) and clear matched.
   */
  reset(pos: number = 0): this {
    this._pos = Math.max(0, Math.min(pos, this._source.length));
    this._matched = null;
    this._lastMatchPos = 0;
    return this;
  }

  /** Return the full source string. */
  toString(): string {
    return this._source;
  }

  // -- private --

  private _toAnchored(pattern: RegExp | string): RegExp {
    if (typeof pattern === "string") {
      return new RegExp("^" + escapeRegExp(pattern));
    }
    const flags = pattern.flags.replace("g", "").replace("m", "");
    return new RegExp("^(?:" + pattern.source + ")", flags);
  }

  private _toUnanchored(pattern: RegExp | string): RegExp {
    if (typeof pattern === "string") {
      return new RegExp(escapeRegExp(pattern));
    }
    const flags = pattern.flags.replace("g", "");
    return new RegExp(pattern.source, flags);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
