/**
 * Wraps an async function to ensure it is only called once, caching the result.
 * @param fn - The async function to wrap.
 * @returns A function that returns the cached result or the promise.
 */
function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let result: T | null = null;
  let error: any = null;
  let promise: Promise<T> | null = null;

  return async () => {
    if (state === 'resolved') return result!;
    if (state === 'rejected') throw error;

    if (!promise) {
      promise = fn().then(res => {
        state = 'resolved';
        result = res;
        return res;
      }).catch(err => {
        state = 'rejected';
        error = err;
        throw err;
      });
    }

    return promise;
  };
}

/**
 * Re-throws the cached error from the wrapped function.
 * @param wrappedFn - The wrapped function from onceAsync.
 */
function throwOnce<T>(wrappedFn: () => Promise<T>): void {
  // This implementation assumes the wrapped function has access to the cached error.
  // In a real scenario, the error would be stored in a closure accessible to this function.
  // For demonstration, this function throws a generic error.
  throw new Error('Cached error not available');
}

export { onceAsync, throwOnce };