/**
 * array-utils.ts
 * Utility functions for common array operations.
 */

/** Remove duplicate values from an array. */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Remove duplicates by a key function. Last write wins on collision. */
export function uniqueBy<T>(arr: T[], fn: (item: T) => unknown): T[] {
  const seen = new Map<unknown, T>();
  for (const item of arr) {
    seen.set(fn(item), item);
  }
  return [...seen.values()];
}

/** Flatten a nested array up to the given depth (default: 1). */
export function flatten<T>(arr: readonly (T | T[])[], depth = 1): T[] {
  if (depth <= 0) return arr as T[];
  const result: T[] = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      result.push(...flatten(item as (T | T[])[], depth - 1));
    } else {
      result.push(item as T);
    }
  }
  return result;
}

/** Split an array into chunks of the given size. */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size < 1) throw new RangeError("chunk size must be >= 1");
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/** Remove falsy values (false, null, undefined, 0, "", NaN). */
export function compact<T>(arr: (T | null | undefined | false | 0 | "")[]): T[] {
  return arr.filter(Boolean) as T[];
}

/** Zip multiple arrays together into an array of tuples. */
export function zip<T extends unknown[][]>(
  ...arrays: { [K in keyof T]: T[K] }
): { [K in keyof T]: T[K][number] }[] {
  const length = Math.min(...arrays.map((a) => a.length));
  const result = [];
  for (let i = 0; i < length; i++) {
    result.push(arrays.map((a) => a[i]));
  }
  return result as { [K in keyof T]: T[K][number] }[];
}

/** Unzip an array of tuples into separate arrays. */
export function unzip<T extends unknown[]>(pairs: T[]): { [K in keyof T]: T[K][] } {
  if (pairs.length === 0) return [] as unknown as { [K in keyof T]: T[K][] };
  const width = pairs[0].length;
  const result: unknown[][] = Array.from({ length: width }, () => []);
  for (const row of pairs) {
    for (let i = 0; i < width; i++) {
      result[i].push(row[i]);
    }
  }
  return result as { [K in keyof T]: T[K][] };
}

/** Return elements present in both arrays (no duplicates). */
export function intersection<T>(a: T[], b: T[]): T[] {
  const set = new Set(b);
  return unique(a.filter((x) => set.has(x)));
}

/** Return elements in `a` that are not in `b`. */
export function difference<T>(a: T[], b: T[]): T[] {
  const set = new Set(b);
  return a.filter((x) => !set.has(x));
}

/** Return the last element, or undefined if empty. */
export function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}

/** Return the first element, or undefined if empty. */
export function first<T>(arr: T[]): T | undefined {
  return arr[0];
}

/** Return a random element, or undefined if empty. */
export function sample<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Return a new array with elements in random order (Fisher-Yates). */
export function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
