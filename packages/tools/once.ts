/**
 * Ensures a function is called at most once.
 * @param fn The function to wrap.
 * @returns A function that only executes on the first call.
 */
function once<T>(fn: () => T): () => T {
  let called = false;
  let result: T;

  function wrapped(): T {
    if (called) {
      return result;
    }
    called = true;
    result = fn();
    return result;
  }

  wrapped.reset = () => {
    called = false;
    result = undefined;
  };

  return wrapped;
}

/**
 * Promise-returning version of once.
 * @param fn The async function to wrap.
 * @returns A function that returns a promise and only executes on the first call.
 */
function onceAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let called = false;
  let result: T;

  async function wrapped(): Promise<T> {
    if (called) {
      return Promise.resolve(result);
    }
    called = true;
    result = await fn();
    return result;
  }

  wrapped.reset = () => {
    called = false;
    result = undefined;
  };

  return wrapped;
}

/**
 * Resets the wrapped function to allow re-execution.
 * @param onceFn The function returned by once or onceAsync.
 */
function reset(onceFn: { reset: () => void }): void {
  onceFn.reset();
}

export { once, onceAsync, reset };