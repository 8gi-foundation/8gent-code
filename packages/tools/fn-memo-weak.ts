/**
 * WeakRef-based memoization. When the key object is garbage collected,
 * the cached result is automatically cleaned up. Zero dependencies.
 */

/**
 * Memoize a function using a WeakMap. Cache entries are automatically
 * released when the key object is garbage collected.
 */
export function memoWeak<K extends object, V>(fn: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();

  return (key: K): V => {
    if (cache.has(key)) {
      return cache.get(key) as V;
    }
    const result = fn(key);
    cache.set(key, result);
    return result;
  };
}

/**
 * Memoize an async function using a WeakMap. Cache entries are automatically
 * released when the key object is garbage collected. Concurrent calls with
 * the same key share the in-flight promise rather than triggering duplicate
 * executions.
 */
export function memoWeakAsync<K extends object, V>(
  fn: (key: K) => Promise<V>
): (key: K) => Promise<V> {
  const cache = new WeakMap<K, Promise<V>>();

  return (key: K): Promise<V> => {
    if (cache.has(key)) {
      return cache.get(key) as Promise<V>;
    }
    const promise = fn(key).finally(() => {
      // Remove settled promise so future calls re-execute if key still alive.
      cache.delete(key);
    });
    cache.set(key, promise);
    return promise;
  };
}
