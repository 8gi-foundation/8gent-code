/**
 * stream-transform.ts
 *
 * Composable async-iterable pipeline for processing agent output.
 * Chain map, filter, batch, and throttle transforms with no external deps.
 */

export type AsyncIter<T> = AsyncIterable<T>;
export type Transform<A, B> = (source: AsyncIter<A>) => AsyncIter<B>;

export function pipeline(source: AsyncIter<unknown>, ...transforms: Transform<unknown, unknown>[]): AsyncIter<unknown> {
  return transforms.reduce((stream, t) => t(stream), source);
}

export function map<T, U>(fn: (chunk: T) => U | Promise<U>): Transform<T, U> {
  return async function* (source) {
    for await (const chunk of source) {
      yield await fn(chunk);
    }
  };
}

export function filter<T>(pred: (chunk: T) => boolean | Promise<boolean>): Transform<T, T> {
  return async function* (source) {
    for await (const chunk of source) {
      if (await pred(chunk)) yield chunk;
    }
  };
}

export function batch<T>(size: number): Transform<T, T[]> {
  if (size < 1) throw new RangeError("batch size must be >= 1");
  return async function* (source) {
    let buf: T[] = [];
    for await (const chunk of source) {
      buf.push(chunk);
      if (buf.length >= size) {
        yield buf;
        buf = [];
      }
    }
    if (buf.length > 0) yield buf;
  };
}

export function throttle<T>(minIntervalMs: number): Transform<T, T> {
  return async function* (source) {
    let last = 0;
    for await (const chunk of source) {
      const now = Date.now();
      const wait = minIntervalMs - (now - last);
      if (wait > 0) await delay(wait);
      last = Date.now();
      yield chunk;
    }
  };
}

export function flatMap<T, U>(fn: (chunk: T) => U[] | AsyncIterable<U> | Promise<U[]>): Transform<T, U> {
  return async function* (source) {
    for await (const chunk of source) {
      const result = await fn(chunk);
      if (Symbol.asyncIterator in Object(result)) {
        yield* result as AsyncIterable<U>;
      } else {
        yield* result as U[];
      }
    }
  };
}

export function take<T>(n: number): Transform<T, T> {
  return async function* (source) {
    let count = 0;
    for await (const chunk of source) {
      yield chunk;
      if (++count >= n) return;
    }
  };
}

export function tap<T>(fn: (chunk: T) => void | Promise<void>): Transform<T, T> {
  return async function* (source) {
    for await (const chunk of source) {
      await fn(chunk);
      yield chunk;
    }
  };
}

export async function collect<T>(source: AsyncIter<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const chunk of source) result.push(chunk);
  return result;
}

export async function* fromArray<T>(items: T[]): AsyncIter<T> {
  for (const item of items) yield item;
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
