/**
 * ResponseStreamer - streams LLM responses with token-by-token processing.
 *
 * Buffers incoming tokens, detects sentence boundaries, emits sentence-level
 * chunks, accumulates the full response, handles backpressure, and word-wraps
 * output for terminal display.
 */

export interface StreamerOptions {
  /** Max terminal column width for word-wrap. Default: 80. */
  columns?: number;
  /** Max buffered chunks before backpressure kicks in. Default: 16. */
  highWaterMark?: number;
  /** Called for each emitted sentence chunk. */
  onChunk?: (chunk: string) => void;
  /** Called once the stream finishes with the full accumulated response. */
  onComplete?: (full: string) => void;
}

const SENTENCE_END = /[.!?]\s+|[.!?]$/;

export class ResponseStreamer {
  private buffer = "";
  private full = "";
  private queue: string[] = [];
  private draining = false;
  private columns: number;
  private highWaterMark: number;
  private onChunk: (chunk: string) => void;
  private onComplete: (full: string) => void;

  constructor(opts: StreamerOptions = {}) {
    this.columns = opts.columns ?? 80;
    this.highWaterMark = opts.highWaterMark ?? 16;
    this.onChunk = opts.onChunk ?? (() => {});
    this.onComplete = opts.onComplete ?? (() => {});
  }

  /**
   * Push a token into the streamer. Returns false when backpressure is active;
   * the caller should pause sending until the queue drains.
   */
  push(token: string): boolean {
    this.buffer += token;
    this.full += token;
    this._tryFlush();
    return this.queue.length < this.highWaterMark;
  }

  /**
   * Signal end-of-stream. Flushes remaining buffer content as a final chunk.
   */
  end(): void {
    if (this.buffer.trim().length > 0) {
      const wrapped = this._wordWrap(this.buffer.trim());
      this.queue.push(wrapped);
      this.buffer = "";
    }
    this._drain();
    this.onComplete(this.full);
  }

  /** Accumulated full response text so far. */
  get accumulated(): string {
    return this.full;
  }

  /** Number of chunks currently waiting in the queue. */
  get queued(): number {
    return this.queue.length;
  }

  // ---

  private _tryFlush(): void {
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = SENTENCE_END.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence.length > 0) {
        const wrapped = this._wordWrap(sentence);
        this.queue.push(wrapped);
      }
    }
    if (!this.draining) {
      this._drain();
    }
  }

  private _drain(): void {
    this.draining = true;
    while (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      this.onChunk(chunk);
    }
    this.draining = false;
  }

  /**
   * Word-wrap a string to the configured column width.
   * Preserves existing newlines; splits only on spaces.
   */
  private _wordWrap(text: string): string {
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
      const words = paragraph.split(" ");
      let current = "";
      for (const word of words) {
        if (current.length === 0) {
          current = word;
        } else if (current.length + 1 + word.length <= this.columns) {
          current += " " + word;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current.length > 0) lines.push(current);
    }
    return lines.join("\n");
  }
}
