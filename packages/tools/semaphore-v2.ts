/**
 * Async semaphore for concurrency control.
 * Zero dependencies, under 50 lines.
 */

export interface Semaphore {
  acquire(): Promise<() => void>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSemaphore(maxConcurrent: number): Semaphore {
  let active = 0;
  const queue: Array<() => void> = [];

  function tryNext(): void {
    if (queue.length > 0 && active < maxConcurrent) {
      active++;
      const resolve = queue.shift()!;
      resolve();
    }
  }

  function acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryAcquire = () => {
        active++;
        const release = () => {
          active--;
          tryNext();
        };
        resolve(release);
      };

      if (active < maxConcurrent) {
        tryAcquire();
      } else {
        queue.push(tryAcquire);
      }
    });
  }

  async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { acquire, runExclusive };
}
