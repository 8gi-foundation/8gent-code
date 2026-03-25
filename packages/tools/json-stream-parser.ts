/**
 * JSONStreamParser - incremental streaming JSON parser
 *
 * Parses partial/streaming JSON text as chunks arrive, emitting complete
 * values as they are detected. Supports NDJSON (newline-delimited JSON),
 * recoverable parse errors, and partial string/number handling.
 */

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
type ValueCallback = (value: JSONValue) => void;

export class JSONStreamParser {
  private buffer: string = "";
  private callbacks: ValueCallback[] = [];
  private ndjson: boolean;
  private depth: number = 0;
  private inString: boolean = false;
  private escape: boolean = false;
  private valueStart: number = -1;

  constructor(options: { ndjson?: boolean } = {}) {
    this.ndjson = options.ndjson ?? false;
  }

  /** Register a callback to receive each complete parsed value. */
  onValue(callback: ValueCallback): this {
    this.callbacks.push(callback);
    return this;
  }

  /** Feed a chunk of JSON text. May emit zero or more values via onValue callbacks. */
  feed(chunk: string): this {
    this.buffer += chunk;

    if (this.ndjson) {
      this._processNDJSON();
    } else {
      this._processStream();
    }

    return this;
  }

  /** Flush remaining buffer. Call when stream ends to attempt parsing any trailing content. */
  flush(): this {
    const remaining = this.buffer.trim();
    if (remaining.length > 0) {
      this._tryEmit(remaining);
    }
    this.buffer = "";
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.valueStart = -1;
    return this;
  }

  private _processNDJSON(): void {
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this._tryEmit(line);
      }
    }
  }

  private _processStream(): void {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];

      if (this.escape) {
        this.escape = false;
        continue;
      }

      if (this.inString) {
        if (ch === "\\") {
          this.escape = true;
        } else if (ch === '"') {
          this.inString = false;
          if (this.depth === 0 && this.valueStart !== -1) {
            // Top-level string value completed
            const candidate = this.buffer.slice(this.valueStart, i + 1);
            this._tryEmit(candidate);
            this.buffer = this.buffer.slice(i + 1);
            i = -1;
            this.valueStart = -1;
          }
        }
        continue;
      }

      if (ch === '"') {
        this.inString = true;
        if (this.depth === 0) {
          this.valueStart = i;
        }
        continue;
      }

      if (ch === "{" || ch === "[") {
        if (this.depth === 0) {
          this.valueStart = i;
        }
        this.depth++;
        continue;
      }

      if (ch === "}" || ch === "]") {
        this.depth--;
        if (this.depth === 0 && this.valueStart !== -1) {
          const candidate = this.buffer.slice(this.valueStart, i + 1);
          this._tryEmit(candidate);
          this.buffer = this.buffer.slice(i + 1);
          i = -1;
          this.valueStart = -1;
        }
        continue;
      }

      // Detect top-level primitives: numbers, booleans, null
      if (this.depth === 0 && this.valueStart === -1) {
        if (ch === "-" || (ch >= "0" && ch <= "9") || ch === "t" || ch === "f" || ch === "n") {
          this.valueStart = i;
          continue;
        }
      }

      // End of top-level primitive (whitespace or comma)
      if (this.depth === 0 && this.valueStart !== -1 && (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === ",")) {
        const candidate = this.buffer.slice(this.valueStart, i).trim();
        if (candidate.length > 0) {
          this._tryEmit(candidate);
        }
        this.buffer = this.buffer.slice(i + 1);
        i = -1;
        this.valueStart = -1;
      }
    }
  }

  private _tryEmit(raw: string): void {
    const text = raw.trim();
    if (text.length === 0) return;
    try {
      const value: JSONValue = JSON.parse(text);
      for (const cb of this.callbacks) {
        cb(value);
      }
    } catch {
      // Recoverable: silently discard malformed fragment, keep streaming
    }
  }
}
