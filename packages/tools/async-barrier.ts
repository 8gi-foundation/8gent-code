/**
 * async-barrier.ts
 *
 * Synchronization primitives for coordinating multiple async tasks.
 *
 * Barrier       - N parties must arrive before any can proceed.
 * CountdownLatch - N events must fire before waiting callers are unblocked.
 */

// ---------------------------------------------------------------------------
// Barrier
// ---------------------------------------------------------------------------

/**
 * A cyclic synchronization barrier.
 *
 * All `count` parties must call `arrive()` before any of them receives a
 * resolved promise. After every `count`-th arrival the barrier automatically
 * resets for the next generation, enabling repeated use without explicit
 * calls to `reset()`.
 *
 * @example
 * const barrier = new Barrier(3);
 * await Promise.all([worker(0), worker(1), worker(2)]);
 *
 * async function worker(id: number) {
 *   console.log(`${id} before barrier`);
 *   await barrier.arrive();
 *   console.log(`${id} after barrier`);
 * }
 */
export class Barrier {
  private readonly total: number;
  private waiting: number;
  private resolvers: Array<() => void>;

  constructor(count: number) {
    if (count < 1) throw new RangeError("Barrier count must be >= 1");
    this.total = count;
    this.waiting = 0;
    this.resolvers = [];
  }

  /**
   * Signal arrival at the barrier.
   * Returns a promise that resolves once all parties have arrived.
   */
  arrive(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
      this.waiting += 1;

      if (this.waiting === this.total) {
        const toRelease = this.resolvers.splice(0);
        this.waiting = 0;
        for (const r of toRelease) r();
      }
    });
  }

  /**
   * Forcibly reset the barrier, discarding any currently waiting promises.
   * Use when aborting a generation mid-flight.
   */
  reset(): void {
    this.resolvers.splice(0);
    this.waiting = 0;
  }

  /** Number of parties still waiting for this generation to complete. */
  get pendingCount(): number {
    return this.waiting;
  }
}

// ---------------------------------------------------------------------------
// CountdownLatch
// ---------------------------------------------------------------------------

/**
 * A single-use countdown latch.
 *
 * Starts at `count`. Each call to `countDown()` decrements the counter.
 * When the counter reaches zero all callers awaiting `wait()` are released.
 *
 * Unlike `Barrier`, a `CountdownLatch` is NOT cyclic. Once it reaches zero
 * all subsequent `wait()` calls resolve immediately. Call `reset()` to
 * rearm it for a new count.
 *
 * @example
 * const latch = new CountdownLatch(3);
 * startWorkers(latch);          // each worker calls latch.countDown()
 * await latch.wait();           // blocks until all three workers are done
 * console.log("all done");
 */
export class CountdownLatch {
  private count: number;
  private readonly initial: number;
  private resolvers: Array<() => void>;

  constructor(count: number) {
    if (count < 1) throw new RangeError("CountdownLatch count must be >= 1");
    this.initial = count;
    this.count = count;
    this.resolvers = [];
  }

  /**
   * Decrement the counter.
   * When it reaches zero all waiting promises are resolved.
   */
  countDown(): void {
    if (this.count <= 0) return;
    this.count -= 1;
    if (this.count === 0) {
      const toRelease = this.resolvers.splice(0);
      for (const r of toRelease) r();
    }
  }

  /**
   * Wait until the counter reaches zero.
   * Resolves immediately if the counter is already at zero.
   */
  wait(): Promise<void> {
    if (this.count <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /**
   * Rearm the latch with a new count (or the original count if omitted).
   * Any currently waiting callers are NOT released.
   */
  reset(count: number | undefined = undefined): void {
    this.count = count !== undefined ? count : this.initial;
    if (this.count < 1) throw new RangeError("CountdownLatch count must be >= 1");
  }

  /** Current remaining count. */
  get remaining(): number {
    return this.count;
  }
}
