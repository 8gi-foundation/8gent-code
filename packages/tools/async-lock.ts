/**
 * async-lock: Mutex and RWLock for safe concurrent async resource access.
 * Self-contained, no dependencies.
 */

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

// ---- Mutex ----------------------------------------------------------------

type Resolve = () => void;

export class Mutex {
  private _locked = false;
  private _queue: Resolve[] = [];

  async acquire(timeoutMs?: number): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return this._release.bind(this);
    }

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;

      const entry: Resolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._locked = true;
        resolve(this._release.bind(this));
      };

      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              const idx = this._queue.indexOf(entry);
              if (idx !== -1) this._queue.splice(idx, 1);
              reject(new TimeoutError("Mutex.acquire timed out"));
            }, timeoutMs)
          : undefined;

      this._queue.push(entry);
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }

  async runExclusive<T>(fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get isLocked(): boolean {
    return this._locked;
  }
}

// ---- RWLock ---------------------------------------------------------------

type RWResolve = () => void;

export class RWLock {
  private _readers = 0;
  private _writing = false;
  private _readQueue: RWResolve[] = [];
  private _writeQueue: RWResolve[] = [];

  async acquireRead(timeoutMs?: number): Promise<() => void> {
    if (!this._writing && this._writeQueue.length === 0) {
      this._readers++;
      return this._releaseRead.bind(this);
    }

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;

      const entry: RWResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._readers++;
        resolve(this._releaseRead.bind(this));
      };

      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              const idx = this._readQueue.indexOf(entry);
              if (idx !== -1) this._readQueue.splice(idx, 1);
              reject(new TimeoutError("RWLock.acquireRead timed out"));
            }, timeoutMs)
          : undefined;

      this._readQueue.push(entry);
    });
  }

  async acquireWrite(timeoutMs?: number): Promise<() => void> {
    if (!this._writing && this._readers === 0) {
      this._writing = true;
      return this._releaseWrite.bind(this);
    }

    return new Promise<() => void>((resolve, reject) => {
      let settled = false;

      const entry: RWResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._writing = true;
        resolve(this._releaseWrite.bind(this));
      };

      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              const idx = this._writeQueue.indexOf(entry);
              if (idx !== -1) this._writeQueue.splice(idx, 1);
              reject(new TimeoutError("RWLock.acquireWrite timed out"));
            }, timeoutMs)
          : undefined;

      this._writeQueue.push(entry);
    });
  }

  private _releaseRead(): void {
    this._readers--;
    this._dispatch();
  }

  private _releaseWrite(): void {
    this._writing = false;
    this._dispatch();
  }

  private _dispatch(): void {
    if (this._writeQueue.length > 0 && this._readers === 0 && !this._writing) {
      const next = this._writeQueue.shift()!;
      next();
    } else if (this._writeQueue.length === 0) {
      const pending = this._readQueue.splice(0);
      for (const r of pending) r();
    }
  }

  async runRead<T>(fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    const release = await this.acquireRead(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async runWrite<T>(fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    const release = await this.acquireWrite(timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  get readers(): number {
    return this._readers;
  }

  get isWriting(): boolean {
    return this._writing;
  }
}
