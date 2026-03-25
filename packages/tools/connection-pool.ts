/**
 * Generic resource pool for database/HTTP connections.
 * Supports min/max sizing, idle timeout, acquire timeout, and health validation.
 */

export interface PoolConfig<T> {
  min: number;
  max: number;
  idleTimeout: number;    // ms - destroy idle connections after this
  acquireTimeout: number; // ms - throw if no connection available in time
  create: () => Promise<T>;
  destroy: (conn: T) => Promise<void>;
  validate?: (conn: T) => Promise<boolean>;
}

interface PoolEntry<T> {
  conn: T;
  lastUsed: number;
  inUse: boolean;
}

export interface PoolStats {
  total: number;
  active: number;
  idle: number;
  waiting: number;
  min: number;
  max: number;
}

type Waiter<T> = {
  resolve: (conn: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class ConnectionPool<T> {
  private entries: PoolEntry<T>[] = [];
  private waiters: Waiter<T>[] = [];
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private drained = false;

  constructor(private readonly config: PoolConfig<T>) {
    this._startIdleReaper();
    this._ensureMin();
  }

  async acquire(): Promise<T> {
    if (this.drained) throw new Error("Pool has been drained");

    // Try idle connection first
    const entry = this.entries.find((e) => !e.inUse);
    if (entry) {
      const valid = this.config.validate ? await this.config.validate(entry.conn) : true;
      if (valid) {
        entry.inUse = true;
        entry.lastUsed = Date.now();
        return entry.conn;
      }
      // Invalid - remove and fall through to create
      await this._removeEntry(entry);
    }

    // Grow pool if under max
    if (this.entries.length < this.config.max) {
      const conn = await this.config.create();
      this.entries.push({ conn, lastUsed: Date.now(), inUse: true });
      return conn;
    }

    // Pool is full - wait for a release
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`Acquire timeout after ${this.config.acquireTimeout}ms`));
      }, this.config.acquireTimeout);

      const waiter: Waiter<T> = { resolve, reject, timer };
      this.waiters.push(waiter);
    });
  }

  async release(conn: T): Promise<void> {
    const entry = this.entries.find((e) => e.conn === conn);
    if (!entry) return;

    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      clearTimeout(waiter.timer);
      entry.lastUsed = Date.now();
      waiter.resolve(conn);
      return;
    }

    entry.inUse = false;
    entry.lastUsed = Date.now();
  }

  async destroy(conn: T): Promise<void> {
    const entry = this.entries.find((e) => e.conn === conn);
    if (!entry) return;
    await this._removeEntry(entry);
    await this._ensureMin();
  }

  async drain(): Promise<void> {
    this.drained = true;
    if (this.idleTimer) clearInterval(this.idleTimer);

    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pool drained"));
    }
    this.waiters = [];

    await Promise.all(this.entries.map((e) => this.config.destroy(e.conn)));
    this.entries = [];
  }

  stats(): PoolStats {
    const active = this.entries.filter((e) => e.inUse).length;
    return {
      total: this.entries.length,
      active,
      idle: this.entries.length - active,
      waiting: this.waiters.length,
      min: this.config.min,
      max: this.config.max,
    };
  }

  private async _removeEntry(entry: PoolEntry<T>): Promise<void> {
    this.entries = this.entries.filter((e) => e !== entry);
    await this.config.destroy(entry.conn);
  }

  private async _ensureMin(): Promise<void> {
    while (!this.drained && this.entries.length < this.config.min) {
      const conn = await this.config.create();
      this.entries.push({ conn, lastUsed: Date.now(), inUse: false });
    }
  }

  private _startIdleReaper(): void {
    this.idleTimer = setInterval(async () => {
      const now = Date.now();
      const idle = this.entries.filter(
        (e) => !e.inUse && now - e.lastUsed > this.config.idleTimeout
      );
      for (const entry of idle) {
        if (this.entries.length - 1 >= this.config.min) {
          await this._removeEntry(entry);
        }
      }
    }, Math.max(1000, this.config.idleTimeout / 2));
  }
}
