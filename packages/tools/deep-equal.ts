/**
 * deep-equal - deep structural equality comparison
 *
 * Handles: circular refs, Date, Map, Set, RegExp, Buffer,
 * custom comparators, and strict/loose mode.
 */

export interface DeepEqualOptions {
  /** strict: type coercion disabled, NaN === NaN, +0 !== -0. Default: true */
  strict?: boolean;
  /** Custom comparator called before built-in checks. Return undefined to fall through. */
  comparator?: (a: unknown, b: unknown) => boolean | undefined;
}

type Seen = Map<unknown, unknown>;

function isPrimitive(v: unknown): boolean {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

function strictIs(a: unknown, b: unknown): boolean {
  // SameValueZero but with strict mode: NaN === NaN, +0 !== -0
  if (a !== a && b !== b) return true; // both NaN
  if (a === 0 && b === 0) return 1 / (a as number) === 1 / (b as number);
  return a === b;
}

function looseIs(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line eqeqeq
  return a == b;
}

function compareArrays(
  a: unknown[],
  b: unknown[],
  opts: Required<DeepEqualOptions>,
  seen: Seen
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!_deepEqual(a[i], b[i], opts, seen)) return false;
  }
  return true;
}

function compareMaps(
  a: Map<unknown, unknown>,
  b: Map<unknown, unknown>,
  opts: Required<DeepEqualOptions>,
  seen: Seen
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k)) return false;
    if (!_deepEqual(v, b.get(k), opts, seen)) return false;
  }
  return true;
}

function compareSets(
  a: Set<unknown>,
  b: Set<unknown>,
  opts: Required<DeepEqualOptions>,
  seen: Seen
): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    // Sets require an O(n^2) check because keys are values
    let found = false;
    for (const w of b) {
      if (_deepEqual(v, w, opts, seen)) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function compareObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  opts: Required<DeepEqualOptions>,
  seen: Seen
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!_deepEqual(a[k], b[k], opts, seen)) return false;
  }
  return true;
}

function _deepEqual(
  a: unknown,
  b: unknown,
  opts: Required<DeepEqualOptions>,
  seen: Seen
): boolean {
  // Custom comparator first
  const custom = opts.comparator(a, b);
  if (custom !== undefined) return custom;

  // Primitives
  if (opts.strict) {
    if (isPrimitive(a) || isPrimitive(b)) return strictIs(a, b);
  } else {
    if (isPrimitive(a) || isPrimitive(b)) return looseIs(a, b);
  }

  // Both are objects from here
  if (opts.strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
    return false;
  }

  // Circular reference guard
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);

  try {
    // Date
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }

    // RegExp
    if (a instanceof RegExp && b instanceof RegExp) {
      return a.source === b.source && a.flags === b.flags;
    }

    // Buffer / Uint8Array
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    // Map
    if (a instanceof Map && b instanceof Map) {
      return compareMaps(a, b, opts, seen);
    }

    // Set
    if (a instanceof Set && b instanceof Set) {
      return compareSets(a, b, opts, seen);
    }

    // Array
    if (Array.isArray(a) && Array.isArray(b)) {
      return compareArrays(a as unknown[], b as unknown[], opts, seen);
    }

    // Plain object (including null-prototype objects)
    return compareObjects(
      a as Record<string, unknown>,
      b as Record<string, unknown>,
      opts,
      seen
    );
  } finally {
    seen.delete(a);
  }
}

const DEFAULTS: Required<DeepEqualOptions> = {
  strict: true,
  comparator: () => undefined,
};

/**
 * Returns true if `a` and `b` are deeply structurally equal.
 *
 * @param a - left-hand value
 * @param b - right-hand value
 * @param options - strict/loose mode, custom comparator
 */
export function deepEqual(
  a: unknown,
  b: unknown,
  options: DeepEqualOptions = {}
): boolean {
  const opts: Required<DeepEqualOptions> = {
    strict: options.strict ?? DEFAULTS.strict,
    comparator: options.comparator ?? DEFAULTS.comparator,
  };
  return _deepEqual(a, b, opts, new Map());
}

/**
 * Returns true if `a` and `b` are NOT deeply structurally equal.
 */
export function notEqual(
  a: unknown,
  b: unknown,
  options: DeepEqualOptions = {}
): boolean {
  return !deepEqual(a, b, options);
}
