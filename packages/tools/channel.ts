/**
 * Go-style channels for async communication between tasks.
 * Supports buffered channels with capacity limits and select for multi-channel waiting.
 */

type Resolve<T> = (value: T) => void;
type Reject = (reason?: unknown) => void;

interface PendingReceiver<T> {
  resolve: Resolve<T | undefined>;
  reject: Reject;
}

export class Channel<T> {
  private buffer: T[] = [];
  private capacity: number;
  private closed = false;
  private pendingReceivers: PendingReceiver<T>[] = [];
  private pendingSenders: Array<{ value: T; resolve: () => void; reject: Reject }> = [];

  constructor(capacity = 0) {
    this.capacity = capacity;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.buffer.length;
  }

  send(value: T): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("send on closed channel"));
    }

    // If there's a pending receiver, hand off immediately
    const receiver = this.pendingReceivers.shift();
    if (receiver) {
      receiver.resolve(value);
      return Promise.resolve();
    }

    // If buffer has space, buffer it
    if (this.buffer.length < this.capacity) {
      this.buffer.push(value);
      return Promise.resolve();
    }

    // Unbuffered or buffer full - block sender
    return new Promise<void>((resolve, reject) => {
      this.pendingSenders.push({ value, resolve, reject });
    });
  }

  receive(): Promise<T | undefined> {
    // Drain buffer first
    if (this.buffer.length > 0) {
      const value = this.buffer.shift()!;
      // Unblock a pending sender into the buffer
      const sender = this.pendingSenders.shift();
      if (sender) {
        this.buffer.push(sender.value);
        sender.resolve();
      }
      return Promise.resolve(value);
    }

    // Unblock a pending sender directly
    const sender = this.pendingSenders.shift();
    if (sender) {
      const value = sender.value;
      sender.resolve();
      return Promise.resolve(value);
    }

    // Channel is closed and empty
    if (this.closed) {
      return Promise.resolve(undefined);
    }

    // Block until a value arrives
    return new Promise<T | undefined>((resolve, reject) => {
      this.pendingReceivers.push({ resolve, reject });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Reject any pending senders
    for (const sender of this.pendingSenders) {
      sender.reject(new Error("send on closed channel"));
    }
    this.pendingSenders = [];

    // Resolve pending receivers with undefined (channel drained)
    for (const receiver of this.pendingReceivers) {
      receiver.resolve(undefined);
    }
    this.pendingReceivers = [];
  }

  /** Iterate all values until channel closes */
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const value = await this.receive();
      if (value === undefined && this.closed) break;
      if (value !== undefined) yield value;
    }
  }
}

export interface SelectResult<T> {
  channel: Channel<T>;
  value: T | undefined;
}

/**
 * Receive from whichever channel produces a value first.
 * Returns as soon as any channel delivers.
 */
export async function select<T>(...channels: Channel<T>[]): Promise<SelectResult<T>> {
  return new Promise((resolve) => {
    const done = { settled: false };

    for (const ch of channels) {
      ch.receive().then((value) => {
        if (!done.settled) {
          done.settled = true;
          resolve({ channel: ch, value });
        }
      });
    }
  });
}
