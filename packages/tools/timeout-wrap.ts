/**
 * Error thrown when a timeout occurs.
 */
class TimeoutError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wraps a promise with a timeout.
 * @param promise The promise to wrap.
 * @param ms The timeout in milliseconds.
 * @param message Optional message for the TimeoutError.
 * @returns A new promise that resolves or rejects with the timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new TimeoutError(message || 'Timeout'));
    }, ms);
    promise.then((value) => {
      clearTimeout(timeoutId);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/**
 * Races multiple promises with a single timeout.
 * @param promises Array of promises to race.
 * @param ms The timeout in milliseconds.
 * @returns A promise that resolves when any of the input promises resolve, or rejects with a TimeoutError.
 */
function raceWithTimeout<T>(promises: Promise<T>[], ms: number): Promise<T> {
  return Promise.race([
    ...promises,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError('Timeout'));
      }, ms);
    })
  ]);
}

export { TimeoutError, withTimeout, raceWithTimeout };