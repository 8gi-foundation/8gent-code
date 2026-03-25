/**
 * json-diff - deep structural diff of two JSON values
 *
 * Returns an array of operations describing how to transform `a` into `b`.
 * Each operation has:
 *   op       - 'add' | 'remove' | 'replace'
 *   path     - dot-notation string (e.g. "user.address.city", "items.2")
 *   oldValue - present on 'remove' and 'replace'
 *   newValue - present on 'add' and 'replace'
 */

export type DiffOp = "add" | "remove" | "replace";

export interface DiffEntry {
  op: DiffOp;
  path: string;
  oldValue?: unknown;
  newValue?: unknown;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function isArray(val: unknown): val is unknown[] {
  return Array.isArray(val);
}

function isPrimitive(val: unknown): boolean {
  return !isObject(val) && !isArray(val);
}

function joinPath(base: string, key: string | number): string {
  if (base === "") return String(key);
  return `${base}.${key}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPrimitive(a) || isPrimitive(b)) return false;

  if (isArray(a) && isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }

  // mismatched types (one array, one object)
  return false;
}

function diffRecursive(a: unknown, b: unknown, path: string, result: DiffEntry[]): void {
  // identical - nothing to do
  if (deepEqual(a, b)) return;

  // both primitives (or null) but not equal
  if (isPrimitive(a) && isPrimitive(b)) {
    result.push({ op: "replace", path, oldValue: a, newValue: b });
    return;
  }

  // type mismatch (e.g. object -> array, primitive -> object)
  const bothObjects = isObject(a) && isObject(b);
  const bothArrays = isArray(a) && isArray(b);

  if (!bothObjects && !bothArrays) {
    result.push({ op: "replace", path, oldValue: a, newValue: b });
    return;
  }

  if (bothArrays) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    const maxLen = Math.max(arrA.length, arrB.length);

    for (let i = 0; i < maxLen; i++) {
      const childPath = joinPath(path, i);
      if (i >= arrA.length) {
        result.push({ op: "add", path: childPath, newValue: arrB[i] });
      } else if (i >= arrB.length) {
        result.push({ op: "remove", path: childPath, oldValue: arrA[i] });
      } else {
        diffRecursive(arrA[i], arrB[i], childPath, result);
      }
    }
    return;
  }

  // both plain objects
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(objA), ...Object.keys(objB)]);

  for (const key of allKeys) {
    const childPath = joinPath(path, key);
    const hasA = Object.prototype.hasOwnProperty.call(objA, key);
    const hasB = Object.prototype.hasOwnProperty.call(objB, key);

    if (!hasA) {
      result.push({ op: "add", path: childPath, newValue: objB[key] });
    } else if (!hasB) {
      result.push({ op: "remove", path: childPath, oldValue: objA[key] });
    } else {
      diffRecursive(objA[key], objB[key], childPath, result);
    }
  }
}

/**
 * Compares two JSON-compatible values and returns a structured diff.
 *
 * @param a - original value
 * @param b - updated value
 * @returns array of DiffEntry describing how to transform a into b
 */
export function jsonDiff(a: unknown, b: unknown): DiffEntry[] {
  const result: DiffEntry[] = [];
  diffRecursive(a, b, "", result);
  return result;
}
