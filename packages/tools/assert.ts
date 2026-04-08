/**
 * AssertionError class that includes actual and expected values.
 */
class AssertionError extends Error {
  actual: any;
  expected: any;
  constructor(message?: string, actual?: any, expected?: any) {
    super(message);
    this.actual = actual;
    this.expected = expected;
  }
}

/**
 * Check if two values are deeply equal.
 * @param a - First value.
 * @param b - Second value.
 * @returns True if deeply equal, false otherwise.
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Throw an AssertionError if the condition is false.
 * @param condition - Condition to check.
 * @param message - Optional error message.
 */
function assert(condition: boolean, message?: string): void {
  if (!condition) {
    throw new AssertionError(message, undefined, undefined);
  }
}

/**
 * Throw an AssertionError if a is not equal to b.
 * @param a - First value.
 * @param b - Second value.
 */
function assertEqual(a: any, b: any): void {
  if (a !== b) {
    throw new AssertionError(`Expected ${a} to equal ${b}`, a, b);
  }
}

/**
 * Throw an AssertionError if a is equal to b.
 * @param a - First value.
 * @param b - Second value.
 */
function assertNotEqual(a: any, b: any): void {
  if (a === b) {
    throw new AssertionError(`Expected ${a} to not equal ${b}`, a, b);
  }
}

/**
 * Throw an AssertionError if a is not deeply equal to b.
 * @param a - First value.
 * @param b - Second value.
 */
function assertDeepEqual(a: any, b: any): void {
  if (!deepEqual(a, b)) {
    throw new AssertionError(`Expected ${JSON.stringify(a)} to deeply equal ${JSON.stringify(b)}`, a, b);
  }
}

/**
 * Throw an AssertionError if the function does not throw.
 * @param fn - Function to check.
 */
function assertThrows(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new AssertionError('Expected function to throw', undefined, undefined);
  }
}

/**
 * Return a promise that resolves if the async function rejects, otherwise rejects.
 * @param asyncFn - Async function to check.
 * @returns Promise that resolves if the async function rejects.
 */
function assertRejects(asyncFn: () => Promise<any>): Promise<void> {
  return asyncFn().catch(() => {
    return;
  }).then(() => {
    throw new AssertionError('Expected promise to reject', undefined, undefined);
  });
}

export {
  AssertionError,
  assert,
  assertEqual,
  assertNotEqual,
  assertDeepEqual,
  assertThrows,
  assertRejects
};