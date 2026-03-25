/**
 * A mutex that allows exclusive access to a resource.
 */
export class Mutex {
  private isLocked = false;
  private waiting: Array<() => void> = [];

  /**
   * Acquire the mutex, returning a release function.
   * @param timeout - Optional timeout in milliseconds.
   * @returns A promise that resolves to a release function.
   */
  acquire(timeout?: number): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const timeoutId = timeout ? setTimeout(() => {
        reject(new Error('Mutex timeout'));
      }, timeout) : undefined;
      const release = () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(() => {
          this.isLocked = false;
          if (this.waiting.length > 0) {
            this.waiting.shift()();
          }
        });
      };
      if (!this.isLocked) {
        this.isLocked = true;
        resolve(() => {
          release();
        });
      } else {
        this.waiting.push(() => {
          this.isLocked = true;
          resolve(() => {
            release();
          });
        });
      }
    });
  }

  /**
   * Execute a function with the mutex locked.
   * @param fn - Function to execute under the lock.
   * @returns A promise that resolves when the function completes.
   */
  withLock(fn: () => Promise<void>): Promise<void> {
    return this.acquire().then(release => {
      return fn().finally(release);
    });
  }
}

/**
 * A read-write lock that allows multiple readers or a single writer.
 */
export class ReadWriteLock {
  private readers = 0;
  private writers = 0;
  private readWaiting: Array<() => void> = [];
  private writeWaiting: Array<() => void> = [];

  /**
   * Acquire a read lock.
   * @param timeout - Optional timeout in milliseconds.
   * @returns A promise that resolves to a release function.
   */
  acquireRead(timeout?: number): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const timeoutId = timeout ? setTimeout(() => {
        reject(new Error('Read lock timeout'));
      }, timeout) : undefined;
      const release = () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(() => {
          this.readers--;
          if (this.readers === 0 && this.writeWaiting.length > 0) {
            this.writeWaiting.shift()();
          }
        });
      };
      if (this.writers === 0) {
        this.readers++;
        resolve(() => {
          release();
        });
      } else {
        this.readWaiting.push(() => {
          this.readers++;
          resolve(() => {
            release();
          });
        });
      }
    });
  }

  /**
   * Acquire a write lock.
   * @param timeout - Optional timeout in milliseconds.
   * @returns A promise that resolves to a release function.
   */
  acquireWrite(timeout?: number): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const timeoutId = timeout ? setTimeout(() => {
        reject(new Error('Write lock timeout'));
      }, timeout) : undefined;
      const release = () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(() => {
          this.writers--;
          if (this.readers > 0) {
            this.readWaiting.shift()();
          } else if (this.writeWaiting.length > 0) {
            this.writeWaiting.shift()();
          }
        });
      };
      if (this.readers === 0 && this.writers === 0) {
        this.writers++;
        resolve(() => {
          release();
        });
      } else {
        this.writeWaiting.push(() => {
          this.writers++;
          resolve(() => {
            release();
          });
        });
      }
    });
  }
}

/**
 * A semaphore that limits concurrent access to a resource.
 */
export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(n: number) {
    this.permits = n;
  }

  /**
   * Acquire a permit.
   * @param timeout - Optional timeout in milliseconds.
   * @returns A promise that resolves to a release function.
   */
  acquire(timeout?: number): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const timeoutId = timeout ? setTimeout(() => {
        reject(new Error('Semaphore timeout'));
      }, timeout) : undefined;
      const release = () => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve(() => {
          this.permits++;
          if (this.queue.length > 0) {
            this.queue.shift()();
          }
        });
      };
      if (this.permits > 0) {
        this.permits--;
        resolve(() => {
          release();
        });
      } else {
        this.queue.push(() => {
          this.permits--;
          resolve(() => {
            release();
          });
        });
      }
    });
  }
}

/**
 * Create a new semaphore with the given number of permits.
 * @param n - Number of permits.
 * @returns A new semaphore instance.
 */
export function semaphore(n: number): Semaphore {
  return new Semaphore(n);
}