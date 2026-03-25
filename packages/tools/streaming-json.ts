/**
 * StreamingJsonParser
 *
 * Parses partial/incomplete JSON from LLM streams with no external dependencies.
 *
 * Features:
 * - Incremental chunk ingestion (call .feed() repeatedly)
 * - Trailing comma repair (objects and arrays)
 * - Truncated string/array/object recovery
 * - NDJSON (newline-delimited JSON) mode - yields one object per line
 * - Single-value mode - accumulates chunks into one document
 * - .flush() returns best-effort parse of whatever has been received so far
 * - .reset() clears state for reuse
 */

export type StreamingJsonOptions = {
  /** Enable NDJSON mode: emit a parsed value for every complete newline-terminated JSON line. Default: false */
  ndjson?: boolean;
  /** Maximum buffer size in characters before auto-flush. Default: 1_000_000 */
  maxBuffer?: number;
};

export type ParseResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string; partial?: unknown };

// ---------------------------------------------------------------------------
// Repair helpers
// ---------------------------------------------------------------------------

/** Remove trailing commas before } or ] */
function removeTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Attempt to close any unclosed brackets/braces/strings so the JSON engine
 * can parse what has arrived so far.
 */
function repairTruncated(input: string): string {
  let s = input.trimEnd();

  // Remove a dangling comma at the very end before we close
  s = s.replace(/,\s*$/, "");

  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      if (!inString && stack[stack.length - 1] === '"') {
        stack.pop();
      } else if (inString) {
        stack.push('"');
      }
      continue;
    }

    if (inString) continue;

    if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  // Close open string first
  if (inString) {
    s += '"';
    stack.pop();
  }

  // Close remaining open containers in reverse order
  while (stack.length > 0) {
    const closer = stack.pop()!;
    s = s.replace(/,\s*$/, "");
    s += closer;
  }

  return s;
}

/** Full repair pipeline: trailing commas + truncation recovery */
function repair(input: string): string {
  const withoutTrailingCommas = removeTrailingCommas(input);
  return repairTruncated(withoutTrailingCommas);
}

/** Attempt to parse, returning a ParseResult */
function tryParse<T = unknown>(raw: string): ParseResult<T> {
  // 1. Try as-is
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    // fall through
  }

  // 2. Trailing-comma repair only
  try {
    const cleaned = removeTrailingCommas(raw);
    return { ok: true, value: JSON.parse(cleaned) as T };
  } catch {
    // fall through
  }

  // 3. Full repair (truncation recovery)
  try {
    const repaired = repair(raw);
    return { ok: true, value: JSON.parse(repaired) as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class StreamingJsonParser<T = unknown> {
  private buffer: string = "";
  private readonly ndjson: boolean;
  private readonly maxBuffer: number;

  /** In NDJSON mode, completed values land here until consumed with .take() */
  private completed: T[] = [];

  constructor(options: StreamingJsonOptions = {}) {
    this.ndjson = options.ndjson ?? false;
    this.maxBuffer = options.maxBuffer ?? 1_000_000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Feed a new chunk of text from the stream.
   * In NDJSON mode, any complete lines are parsed and queued.
   * In single-value mode, the chunk is appended to the buffer.
   */
  feed(chunk: string): void {
    if (this.buffer.length + chunk.length > this.maxBuffer) {
      throw new Error(
        `StreamingJsonParser: buffer exceeded maxBuffer (${this.maxBuffer} chars)`
      );
    }

    this.buffer += chunk;

    if (this.ndjson) {
      this._processNdjsonLines();
    }
  }

  /**
   * In NDJSON mode: return all fully-parsed values received so far and clear
   * the completed queue.
   *
   * In single-value mode: attempt to parse the current buffer (with repair)
   * and return a single-element array on success, or empty on failure.
   */
  take(): T[] {
    if (this.ndjson) {
      const out = this.completed;
      this.completed = [];
      return out;
    }

    const result = tryParse<T>(this.buffer);
    if (result.ok) {
      return [result.value];
    }
    return [];
  }

  /**
   * Flush: return a ParseResult for whatever is in the buffer right now.
   * Uses the full repair pipeline if plain parsing fails.
   * Does NOT consume the buffer.
   */
  flush(): ParseResult<T> {
    if (this.ndjson) {
      const line = this.buffer.trim();
      if (!line) {
        return { ok: false, error: "empty buffer" };
      }
      return tryParse<T>(line);
    }

    return tryParse<T>(this.buffer);
  }

  /**
   * Finalise the stream. Equivalent to flush() but also clears the buffer.
   */
  end(): ParseResult<T> {
    const result = this.flush();
    this.buffer = "";
    return result;
  }

  /** Clear all state - ready to reuse for a new stream */
  reset(): void {
    this.buffer = "";
    this.completed = [];
  }

  /** Current raw buffer contents (useful for debugging) */
  get rawBuffer(): string {
    return this.buffer;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _processNdjsonLines(): void {
    let newlineIdx: number;

    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      const result = tryParse<T>(line);
      if (result.ok) {
        this.completed.push(result.value);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

/**
 * One-shot parse with full repair. Useful when you already have the complete
 * (but possibly malformed) string and just need best-effort JSON.
 */
export function parseRepaired<T = unknown>(input: string): ParseResult<T> {
  return tryParse<T>(input);
}

/**
 * Convenience: parse a complete NDJSON string (multiple newline-separated
 * JSON objects) into an array of values, skipping any unparseable lines.
 */
export function parseNdjson<T = unknown>(input: string): T[] {
  const parser = new StreamingJsonParser<T>({ ndjson: true });
  parser.feed(input);
  return parser.take();
}
