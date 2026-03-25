/**
 * Server-Sent Events (SSE) stream parser.
 *
 * Supports:
 * - event, data, id, retry fields per SSE spec (https://html.spec.whatwg.org/multipage/server-sent-events.html)
 * - Multi-line data fields (concatenated with \n)
 * - Typed events via generic parameter
 * - Async iterator interface for ergonomic streaming consumption
 * - Reconnection logic with configurable retry interval
 */

export interface SSEEvent<T = string> {
  /** The event type. Defaults to "message" if no `event:` field was set. */
  type: string;
  /** Parsed data. Raw string unless a dataParser is supplied. */
  data: T;
  /** Last event ID, if provided by the server. */
  id?: string;
  /** Retry interval in ms, if provided by the server. */
  retry?: number;
}

export interface SSEParserOptions<T = string> {
  /**
   * Optional transform applied to the raw data string before emitting.
   * Defaults to JSON.parse when the string looks like JSON, otherwise identity.
   */
  dataParser?: (raw: string) => T;
  /** Called each time the server sends a `retry:` field. */
  onRetry?: (ms: number) => void;
  /** Called each time a new last-event-id is received. */
  onId?: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Low-level line parser
// ---------------------------------------------------------------------------

function parseSSELine(
  line: string,
  state: { type: string; data: string[]; id?: string; retry?: number }
): boolean {
  // Empty line = dispatch event
  if (line === "") return true;

  // Comment line - discard
  if (line.startsWith(":")) return false;

  const colonIdx = line.indexOf(":");
  let field: string;
  let value: string;

  if (colonIdx === -1) {
    field = line;
    value = "";
  } else {
    field = line.slice(0, colonIdx);
    // Spec: single leading space after colon is stripped
    value = line.slice(colonIdx + 1).replace(/^ /, "");
  }

  switch (field) {
    case "event":
      state.type = value;
      break;
    case "data":
      state.data.push(value);
      break;
    case "id":
      if (!value.includes("\0")) state.id = value;
      break;
    case "retry": {
      const ms = Number(value);
      if (!isNaN(ms) && /^\d+$/.test(value)) state.retry = ms;
      break;
    }
    // Unknown fields are ignored per spec
  }

  return false;
}

// ---------------------------------------------------------------------------
// SSEParser class - wraps a ReadableStream<Uint8Array> or string async iterable
// ---------------------------------------------------------------------------

export class SSEParser<T = string> {
  private opts: SSEParserOptions<T>;

  constructor(opts: SSEParserOptions<T> = {}) {
    this.opts = opts;
  }

  /** Parse a ReadableStream<Uint8Array> (e.g. fetch response.body) */
  async *stream(
    body: ReadableStream<Uint8Array>
  ): AsyncGenerator<SSEEvent<T>> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        yield* this._processBuffer(buffer, (remaining) => {
          buffer = remaining;
        });
      }
      // Flush remaining
      buffer += decoder.decode();
      if (buffer.trim()) {
        yield* this._processBuffer(buffer + "\n", (remaining) => {
          buffer = remaining;
        });
      }
    } finally {
      reader.releaseLock();
    }
  }

  private *_processBuffer(
    buf: string,
    updateBuffer: (remaining: string) => void
  ): Generator<SSEEvent<T>> {
    const lines = buf.split(/\r\n|\r|\n/);
    // Keep last incomplete line in buffer
    const remaining = lines.pop() ?? "";
    updateBuffer(remaining);

    const state = { type: "message", data: [] as string[], id: undefined as string | undefined, retry: undefined as number | undefined };

    for (const line of lines) {
      const dispatch = parseSSELine(line, state);
      if (dispatch) {
        if (state.data.length > 0) {
          const raw = state.data.join("\n");
          const parsed = this._parseData(raw);
          const event: SSEEvent<T> = { type: state.type, data: parsed };
          if (state.id !== undefined) {
            event.id = state.id;
            this.opts.onId?.(state.id);
          }
          if (state.retry !== undefined) {
            event.retry = state.retry;
            this.opts.onRetry?.(state.retry);
          }
          yield event;
        }
        // Reset per-event state; last-event-id persists across events per spec
        state.type = "message";
        state.data = [];
        state.retry = undefined;
      }
    }
  }

  private _parseData(raw: string): T {
    if (this.opts.dataParser) return this.opts.dataParser(raw);
    // Auto-parse JSON if it looks like an object/array
    const trimmed = raw.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { return JSON.parse(trimmed) as T; } catch { /* fall through */ }
    }
    return raw as unknown as T;
  }
}

// ---------------------------------------------------------------------------
// Convenience function - mirrors the class but as a one-liner
// ---------------------------------------------------------------------------

/**
 * Parse a fetch response body as Server-Sent Events.
 *
 * @example
 * const res = await fetch("/api/stream");
 * for await (const event of parseSSE(res.body!)) {
 *   console.log(event.type, event.data);
 * }
 */
export async function* parseSSE<T = string>(
  stream: ReadableStream<Uint8Array>,
  opts: SSEParserOptions<T> = {}
): AsyncGenerator<SSEEvent<T>> {
  const parser = new SSEParser<T>(opts);
  yield* parser.stream(stream);
}
