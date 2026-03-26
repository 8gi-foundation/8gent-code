/**
 * Creates a synchronous data transformation pipeline.
 * @param {...Function} fns - Functions to apply in sequence.
 * @returns {Function} A function that takes an initial value and returns the transformed result.
 */
function pipe<T, R>(...fns: Array<(input: T) => R>): (value: T) => R {
  return (value) => fns.reduce((acc, fn) => fn(acc), value);
}

/**
 * Creates an asynchronous data transformation pipeline.
 * @param {...Function} fns - Async functions to apply in sequence.
 * @returns {Function} A function that takes an initial value and returns a Promise with the transformed result.
 */
function asyncPipe<T, R>(...fns: Array<(input: T) => Promise<R>>): (value: T) => Promise<R> {
  return async (value) => {
    let result = value;
    for (const fn of fns) {
      result = await fn(result);
    }
    return result;
  };
}

export { pipe, asyncPipe };