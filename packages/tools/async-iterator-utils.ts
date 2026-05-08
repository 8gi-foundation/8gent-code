/**
 * async-iterator-utils.ts
 *
 * Utilities for working with async iterators and generators.
 * All functions accept AsyncIterable<T> and work with any generator or stream.
 */

/**
 * Transform each value in an async iterable using a mapping function.
 */
export async function* mapAsync<T, U>(
  iter: AsyncIterable<T>,
  fn: (value: T, index: number) => U | Promise<U>
): AsyncIterable<U> {
  let i = 0;
  for await (const value of iter) {
    yield await fn(value, i++);
  }
}

/**
 * Keep only values that satisfy the predicate.
 */
export async function* filterAsync<T>(
  iter: AsyncIterable<T>,
  fn: (value: T, index: number) => boolean | Promise<boolean>
): AsyncIterable<T> {
  let i = 0;
  for await (const value of iter) {
    if (await fn(value, i++)) yield value;
  }
}

/**
 * Take the first n values from an async iterable, then stop.
 */
export async function* takeAsync<T>(
  iter: AsyncIterable<T>,
  n: number
): AsyncIterable<T> {
  if (n <= 0) return;
  let count = 0;
  for await (const value of iter) {
    yield value;
    if (++count >= n) return;
  }
}

/**
 * Batch values into arrays of a fixed size.
 * The final chunk may be smaller than size if the iterable is exhausted.
 */
export async function* chunkAsync<T>(
  iter: AsyncIterable<T>,
  size: number
): AsyncIterable<T[]> {
  if (size <= 0) throw new RangeError("chunk size must be > 0");
  let batch: T[] = [];
  for await (const value of iter) {
    batch.push(value);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/**
 * Merge multiple async iterables into a single stream.
 * Values are emitted as they arrive - order is not guaranteed across sources.
 * All iterables are consumed concurrently.
 */
export async function* mergeAsync<T>(
  ...iters: AsyncIterable<T>[]
): AsyncIterable<T> {
  const queue: T[] = [];
  let done = 0;
  let resolve: (() => void) | null = null;

  const enqueue = (v: T) => {
    queue.push(v);
    resolve?.();
  };

  const consumers = iters.map(async (iter) => {
    for await (const v of iter) enqueue(v);
    done++;
    resolve?.();
  });

  // Kick off all consumers concurrently without awaiting each in sequence
  const allDone = Promise.all(consumers);

  while (done < iters.length || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((r) => {
        resolve = r;
      });
      resolve = null;
    }
    while (queue.length > 0) {
      yield queue.shift()!;
    }
  }

  await allDone;
}

/**
 * Collect all values from an async iterable into an array.
 */
export async function toArrayAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iter) result.push(value);
  return result;
}

/**
 * Execute a side-effect function for each value. Awaits each call in sequence.
 */
export async function forEachAsync<T>(
  iter: AsyncIterable<T>,
  fn: (value: T, index: number) => void | Promise<void>
): Promise<void> {
  let i = 0;
  for await (const value of iter) {
    await fn(value, i++);
  }
}

/**
 * Reduce an async iterable to a single accumulated value.
 */
export async function reduceAsync<T, U>(
  iter: AsyncIterable<T>,
  fn: (acc: U, value: T, index: number) => U | Promise<U>,
  init: U
): Promise<U> {
  let acc = init;
  let i = 0;
  for await (const value of iter) {
    acc = await fn(acc, value, i++);
  }
  return acc;
}
