/**
 * StreamBuffer - buffers stream data with configurable flush strategies.
 *
 * Flush triggers (all optional, any combination):
 *   - size: flush when buffered bytes >= sizeThreshold
 *   - count: flush when buffered chunk count >= countThreshold
 *   - time: flush every intervalMs milliseconds
 *
 * Supports pause/resume and drain notification.
 */

export interface StreamBufferOptions {
  sizeThreshold?: number;   // bytes
  countThreshold?: number;  // chunk count
  intervalMs?: number;      // auto-flush interval
  onFlush?: (chunks: Uint8Array[]) => void | Promise<void>;
  onDrain?: () => void;
}

export class StreamBuffer {
  private buffer: Uint8Array[] = [];
  private byteSize = 0;
  private chunkCount = 0;
  private paused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private drainPending = false;

  private readonly sizeThreshold: number;
  private readonly countThreshold: number;
  private readonly intervalMs: number | null;
  private readonly onFlush: (chunks: Uint8Array[]) => void | Promise<void>;
  private readonly onDrain: (() => void) | null;

  constructor(options: StreamBufferOptions = {}) {
    this.sizeThreshold = options.sizeThreshold ?? 0;
    this.countThreshold = options.countThreshold ?? 0;
    this.intervalMs = options.intervalMs ?? null;
    this.onFlush = options.onFlush ?? (() => {});
    this.onDrain = options.onDrain ?? null;

    if (this.intervalMs !== null && this.intervalMs > 0) {
      this.timer = setInterval(() => {
        if (!this.paused && this.buffer.length > 0) {
          this.flush();
        }
      }, this.intervalMs);
    }
  }

  /** Write a chunk into the buffer. Triggers auto-flush if thresholds are met. */
  write(data: string | Uint8Array | Buffer): void {
    const chunk =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);

    this.buffer.push(chunk);
    this.byteSize += chunk.byteLength;
    this.chunkCount += 1;

    if (!this.paused) {
      this.maybeAutoFlush();
    }
  }

  /** Flush all buffered chunks immediately, invoking the onFlush callback. */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const chunks = this.buffer.splice(0);
    this.byteSize = 0;
    this.chunkCount = 0;

    try {
      await this.onFlush(chunks);
    } finally {
      this.flushing = false;
      if (this.drainPending) {
        this.drainPending = false;
        this.onDrain?.();
      }
    }
  }

  /** Pause auto-flush. Manual flush() still works. */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume auto-flush. If data accumulated while paused, triggers
   * an immediate flush check.
   */
  resume(): void {
    this.paused = false;
    this.maybeAutoFlush();
  }

  /**
   * Flush remaining data then call onDrain.
   * Useful for graceful shutdown.
   */
  async drain(): Promise<void> {
    if (this.buffer.length === 0) {
      this.onDrain?.();
      return;
    }
    this.drainPending = true;
    await this.flush();
  }

  /** Number of bytes currently buffered. */
  get bufferedBytes(): number {
    return this.byteSize;
  }

  /** Number of chunks currently buffered. */
  get bufferedChunks(): number {
    return this.chunkCount;
  }

  /** Stop the interval timer and release resources. */
  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.buffer = [];
    this.byteSize = 0;
    this.chunkCount = 0;
  }

  private maybeAutoFlush(): void {
    const sizeHit = this.sizeThreshold > 0 && this.byteSize >= this.sizeThreshold;
    const countHit = this.countThreshold > 0 && this.chunkCount >= this.countThreshold;
    if (sizeHit || countHit) {
      this.flush();
    }
  }
}
