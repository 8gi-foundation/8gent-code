/**
 * Lightweight assertion library for agent self-testing.
 * Fluent API with no external dependencies.
 */

export class AssertionError extends Error {
  constructor(
    message: string,
    public readonly expected?: unknown,
    public readonly actual?: unknown,
  ) {
    super(message);
    this.name = "AssertionError";
  }
}

type CustomMatcher = (actual: unknown) => boolean;

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(item: unknown): void;
  toThrow(expectedMessage?: string): void;
  toBeType(type: string): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toMatch(pattern: RegExp): void;
  toHaveLength(length: number): void;
  not: Matchers;
  use(name: string, matcher: CustomMatcher): Matchers;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;

  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);

  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}

function stringify(val: unknown): string {
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function buildMatchers(actual: unknown, negated = false): Matchers {
  const assert = (pass: boolean, msg: string, expected?: unknown) => {
    const shouldFail = negated ? pass : !pass;
    if (shouldFail) {
      throw new AssertionError(negated ? `Expected NOT: ${msg}` : msg, expected, actual);
    }
  };

  const matchers: Matchers = {
    toBe(expected) {
      assert(
        actual === expected,
        `Expected ${stringify(actual)} to be ${stringify(expected)}`,
        expected,
      );
    },

    toEqual(expected) {
      assert(
        deepEqual(actual, expected),
        `Expected ${stringify(actual)} to deeply equal ${stringify(expected)}`,
        expected,
      );
    },

    toContain(item) {
      if (typeof actual === "string") {
        assert(
          actual.includes(String(item)),
          `Expected "${actual}" to contain "${item}"`,
          item,
        );
      } else if (Array.isArray(actual)) {
        assert(
          actual.some((el) => deepEqual(el, item)),
          `Expected array to contain ${stringify(item)}`,
          item,
        );
      } else {
        throw new AssertionError("toContain requires a string or array");
      }
    },

    toThrow(expectedMessage?: string) {
      if (typeof actual !== "function") {
        throw new AssertionError("toThrow requires a function");
      }
      let threw = false;
      let errorMessage = "";
      try {
        (actual as () => void)();
      } catch (e) {
        threw = true;
        errorMessage = e instanceof Error ? e.message : String(e);
      }
      assert(threw, "Expected function to throw");
      if (expectedMessage !== undefined) {
        assert(
          errorMessage.includes(expectedMessage),
          `Expected error message to include "${expectedMessage}", got "${errorMessage}"`,
          expectedMessage,
        );
      }
    },

    toBeType(type) {
      assert(
        typeof actual === type,
        `Expected typeof ${stringify(actual)} to be "${type}", got "${typeof actual}"`,
        type,
      );
    },

    toBeNull() {
      assert(actual === null, `Expected ${stringify(actual)} to be null`);
    },

    toBeUndefined() {
      assert(actual === undefined, `Expected ${stringify(actual)} to be undefined`);
    },

    toBeTruthy() {
      assert(!!actual, `Expected ${stringify(actual)} to be truthy`);
    },

    toBeFalsy() {
      assert(!actual, `Expected ${stringify(actual)} to be falsy`);
    },

    toMatch(pattern) {
      assert(
        typeof actual === "string" && pattern.test(actual),
        `Expected "${actual}" to match ${pattern}`,
        pattern,
      );
    },

    toHaveLength(length) {
      const len = (actual as { length?: number })?.length;
      assert(
        len === length,
        `Expected length ${len} to equal ${length}`,
        length,
      );
    },

    use(name, matcher) {
      assert(
        matcher(actual),
        `Custom matcher "${name}" failed for ${stringify(actual)}`,
      );
      return matchers;
    },

    get not() {
      return buildMatchers(actual, !negated);
    },
  };

  return matchers;
}

/**
 * Entry point for assertions.
 *
 * @example
 * expect(1 + 1).toBe(2);
 * expect([1, 2, 3]).toContain(2);
 * expect(() => { throw new Error("boom") }).toThrow("boom");
 * expect("hello").not.toBe("world");
 */
export function expect(actual: unknown): Matchers {
  return buildMatchers(actual);
}
