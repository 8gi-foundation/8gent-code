/**
 * Array grouping utilities.
 * Pure functions - no side effects, no dependencies.
 */

// ---------------------------------------------------------------------------
// groupBy
// ---------------------------------------------------------------------------

/**
 * Groups an array of items by a key derived from each item.
 *
 * @example
 * groupBy([{type:'a'},{type:'b'},{type:'a'}], x => x.type)
 * // { a: [{type:'a'},{type:'a'}], b: [{type:'b'}] }
 */
export function groupBy<T>(
  arr: T[],
  keyFn: (item: T) => string | number,
): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = String(keyFn(item));
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

// ---------------------------------------------------------------------------
// groupByMultiple
// ---------------------------------------------------------------------------

/**
 * Groups an array by multiple keys in order, producing a nested structure.
 * Each key function peels off one level of grouping.
 *
 * @example
 * groupByMultiple(users, [u => u.country, u => u.role])
 * // { IE: { admin: [...], user: [...] }, UK: { ... } }
 */
export function groupByMultiple<T>(
  arr: T[],
  keyFns: Array<(item: T) => string | number>,
): Record<string, unknown> {
  if (keyFns.length === 0) return arr as unknown as Record<string, unknown>;
  if (keyFns.length === 1) {
    return groupBy(arr, keyFns[0]) as Record<string, unknown>;
  }
  const [first, ...rest] = keyFns;
  const top = groupBy(arr, first);
  const nested: Record<string, unknown> = {};
  for (const [key, items] of Object.entries(top)) {
    nested[key] = groupByMultiple(items, rest);
  }
  return nested;
}

// ---------------------------------------------------------------------------
// countBy
// ---------------------------------------------------------------------------

/**
 * Counts items per key.
 *
 * @example
 * countBy(['a','b','a','c','b','a'], x => x)
 * // { a: 3, b: 2, c: 1 }
 */
export function countBy<T>(
  arr: T[],
  keyFn: (item: T) => string | number,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of arr) {
    const key = String(keyFn(item));
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// indexBy
// ---------------------------------------------------------------------------

/**
 * Indexes items by a unique key. If two items share a key the last one wins.
 * Use when you know the key is unique (e.g. id fields).
 *
 * @example
 * indexBy(users, u => u.id)
 * // { '1': {id:'1', name:'Alice'}, '2': {id:'2', name:'Bob'} }
 */
export function indexBy<T>(
  arr: T[],
  keyFn: (item: T) => string | number,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const item of arr) {
    result[String(keyFn(item))] = item;
  }
  return result;
}

// ---------------------------------------------------------------------------
// partition
// ---------------------------------------------------------------------------

/**
 * Splits an array into two groups: items that pass the predicate and items
 * that do not. Returns [passing, failing].
 *
 * @example
 * partition([1,2,3,4,5], n => n % 2 === 0)
 * // [[2,4], [1,3,5]]
 */
export function partition<T>(
  arr: T[],
  predicate: (item: T) => boolean,
): [T[], T[]] {
  const pass: T[] = [];
  const fail: T[] = [];
  for (const item of arr) {
    if (predicate(item)) pass.push(item);
    else fail.push(item);
  }
  return [pass, fail];
}
