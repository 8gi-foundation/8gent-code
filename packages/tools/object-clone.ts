/**
 * object-clone.ts
 *
 * Shallow and deep object cloning with circular reference handling,
 * custom per-value cloners, and special type support.
 *
 * Handles: Date, Map, Set, RegExp, Buffer, Array, plain objects.
 */

/** A customizer receives (value, key, object) and returns a clone or undefined to fall back to default. */
export type Customizer = (
  value: unknown,
  key: string | number | symbol | undefined,
  obj: unknown
) => unknown;

// -------------------------
// Internal helpers
// -------------------------

const SKIP = Symbol("skip");

function cloneSpecial(val: unknown): unknown | typeof SKIP {
  if (val instanceof Date) return new Date(val.getTime());
  if (val instanceof RegExp) return new RegExp(val.source, val.flags);
  if (val instanceof Map) return new Map(val);
  if (val instanceof Set) return new Set(val);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(val)) {
    return Buffer.from(val as Buffer);
  }
  return SKIP;
}

// -------------------------
// Shallow clone
// -------------------------

/**
 * Shallow clone an object or array.
 * Special types (Date, RegExp, Map, Set, Buffer) are deep-copied.
 * Nested plain objects/arrays keep the same references.
 */
export function clone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;

  const special = cloneSpecial(obj);
  if (special !== SKIP) return special as T;

  if (Array.isArray(obj)) return (obj as unknown[]).slice() as unknown as T;

  return Object.assign(Object.create(Object.getPrototypeOf(obj)), obj) as T;
}

// -------------------------
// Deep clone
// -------------------------

function deepCloneInner(val: unknown, seen: Map<unknown, unknown>): unknown {
  if (val === null || typeof val !== "object") return val;

  if (seen.has(val)) return seen.get(val);

  const special = cloneSpecial(val);
  if (special !== SKIP) {
    seen.set(val, special);
    return special;
  }

  if (Array.isArray(val)) {
    const arr: unknown[] = [];
    seen.set(val, arr);
    for (let i = 0; i < val.length; i++) {
      arr[i] = deepCloneInner(val[i], seen);
    }
    return arr;
  }

  if (val instanceof Map) {
    const m = new Map<unknown, unknown>();
    seen.set(val, m);
    for (const [k, v] of val) {
      m.set(deepCloneInner(k, seen), deepCloneInner(v, seen));
    }
    return m;
  }

  if (val instanceof Set) {
    const s = new Set<unknown>();
    seen.set(val, s);
    for (const item of val) {
      s.add(deepCloneInner(item, seen));
    }
    return s;
  }

  const result: Record<string | symbol, unknown> = Object.create(
    Object.getPrototypeOf(val)
  );
  seen.set(val, result);

  for (const key of [
    ...Object.keys(val as object),
    ...Object.getOwnPropertySymbols(val as object),
  ]) {
    result[key as string] = deepCloneInner(
      (val as Record<string | symbol, unknown>)[key as string],
      seen
    );
  }

  return result;
}

/**
 * Deep clone an object, array, or primitive.
 * Handles circular references via a Map-backed seen set.
 * Handles: Date, RegExp, Map, Set, Buffer, nested arrays and objects.
 */
export function deepClone<T>(obj: T): T {
  return deepCloneInner(obj, new Map()) as T;
}

// -------------------------
// Clone with customizer
// -------------------------

function cloneWithInner(
  val: unknown,
  key: string | number | symbol | undefined,
  parent: unknown,
  customizer: Customizer,
  seen: Map<unknown, unknown>
): unknown {
  const custom = customizer(val, key, parent);
  if (custom !== undefined) return custom;

  if (val === null || typeof val !== "object") return val;

  if (seen.has(val)) return seen.get(val);

  const special = cloneSpecial(val);
  if (special !== SKIP) {
    seen.set(val, special);
    return special;
  }

  if (Array.isArray(val)) {
    const arr: unknown[] = [];
    seen.set(val, arr);
    for (let i = 0; i < val.length; i++) {
      arr[i] = cloneWithInner(val[i], i, val, customizer, seen);
    }
    return arr;
  }

  const result: Record<string | symbol, unknown> = Object.create(
    Object.getPrototypeOf(val)
  );
  seen.set(val, result);

  for (const k of [
    ...Object.keys(val as object),
    ...Object.getOwnPropertySymbols(val as object),
  ]) {
    result[k as string] = cloneWithInner(
      (val as Record<string | symbol, unknown>)[k as string],
      k,
      val,
      customizer,
      seen
    );
  }

  return result;
}

/**
 * Clone an object with a per-value customizer.
 * The customizer(value, key, object) runs for every value.
 * Return a replacement from the customizer or undefined to use default deep-clone logic.
 */
export function cloneWith<T>(obj: T, customizer: Customizer): T {
  return cloneWithInner(obj, undefined, undefined, customizer, new Map()) as T;
}
