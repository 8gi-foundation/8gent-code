/**
 * Lazy initialization wrapper for synchronous resource creation.
 * @param factory - Function to create the resource.
 * @returns Object with `value` property computed on first access.
 */
export function lazy<T>(factory: () => T): { value: T; reset: () => void; isInitialized: () => boolean } {
  let value: T;
  let initialized = false;
  return {
    get value() {
      if (!initialized) {
        value = factory();
        initialized = true;
      }
      return value;
    },
    reset() {
      initialized = false;
    },
    isInitialized() {
      return initialized;
    }
  };
}

/**
 * Lazy initialization wrapper for asynchronous resource creation.
 * @param factory - Function to create the resource asynchronously.
 * @returns Object with `get` method to retrieve the resource.
 */
export function lazyAsync<T>(factory: () => Promise<T>): { get: () => Promise<T>; reset: () => void; isInitialized: () => boolean } {
  let promise: Promise<T> | null = null;
  let initialized = false;
  return {
    get: () => {
      if (!initialized) {
        promise = factory();
        initialized = true;
      }
      return promise!;
    },
    reset() {
      promise = null;
      initialized = false;
    },
    isInitialized() {
      return initialized;
    }
  };
}

/**
 * Reset the cached value of a lazy-initialized resource.
 * @param lazy - The lazy-initialized object to reset.
 */
export function reset<T>(lazy: { reset: () => void }): void {
  lazy.reset();
}

/**
 * Check if a lazy-initialized resource has been initialized.
 * @param lazy - The lazy-initialized object to check.
 * @returns True if initialized, false otherwise.
 */
export function isInitialized<T>(lazy: { isInitialized: () => boolean }): boolean {
  return lazy.isInitialized();
}