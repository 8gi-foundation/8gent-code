/**
 * object-visitor.ts
 *
 * Recursive object walker with enter/leave visitor hooks,
 * leaf-value transformation, and predicate-based collection.
 */

export type Path = (string | number)[];

export interface Visitor {
  enter?: (key: string | number, value: unknown, path: Path) => VisitControl | void;
  leave?: (key: string | number, value: unknown, path: Path) => void;
}

export type VisitControl = "skip" | "stop";

type PlainObject = Record<string, unknown>;

function isTraversable(value: unknown): value is PlainObject | unknown[] {
  return value !== null && typeof value === "object";
}

/**
 * Internal recursive walker. Returns true if traversal should stop globally.
 */
function _walk(
  obj: unknown,
  visitor: Visitor,
  path: Path,
  parentKey: string | number
): boolean {
  const enterResult = visitor.enter?.(parentKey, obj, path);

  if (enterResult === "stop") return true;
  if (enterResult === "skip") return false;

  if (isTraversable(obj)) {
    const entries: [string | number, unknown][] = Array.isArray(obj)
      ? obj.map((v, i) => [i, v])
      : Object.entries(obj as PlainObject);

    for (const [key, value] of entries) {
      const childPath = [...path, key];
      const stopped = _walk(value, visitor, childPath, key);
      if (stopped) return true;
    }
  }

  visitor.leave?.(parentKey, obj, path);
  return false;
}

/**
 * Walk an object recursively, calling visitor.enter and visitor.leave
 * at each node. Return "skip" from enter to skip children, "stop" to
 * abort the entire traversal.
 *
 * @param obj     - The root value to traverse.
 * @param visitor - Object with optional enter/leave callbacks.
 */
export function visit(obj: unknown, visitor: Visitor): void {
  if (!isTraversable(obj)) {
    visitor.enter?.("root", obj, []);
    visitor.leave?.("root", obj, []);
    return;
  }

  const entries: [string | number, unknown][] = Array.isArray(obj)
    ? obj.map((v, i) => [i, v])
    : Object.entries(obj as PlainObject);

  for (const [key, value] of entries) {
    const stopped = _walk(value, visitor, [key], key);
    if (stopped) break;
  }
}

/**
 * Internal recursive transformer. Returns a new value with all leaves mapped.
 */
function _transform(value: unknown, fn: (value: unknown, path: Path) => unknown, path: Path): unknown {
  if (!isTraversable(value)) {
    return fn(value, path);
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => _transform(item, fn, [...path, i]));
  }

  const result: PlainObject = {};
  for (const [k, v] of Object.entries(value as PlainObject)) {
    result[k] = _transform(v, fn, [...path, k]);
  }
  return result;
}

/**
 * Return a deep clone of obj with all leaf values replaced by fn(leaf, path).
 * Non-leaf nodes (arrays and plain objects) are recursed into.
 *
 * @param obj - The root value to transform.
 * @param fn  - Maps each leaf value. Receives the value and its path.
 */
export function transform<T = unknown>(
  obj: unknown,
  fn: (value: unknown, path: Path) => unknown
): T {
  return _transform(obj, fn, []) as T;
}

/**
 * Walk obj and collect every value for which predicate returns true.
 * Both leaf and non-leaf nodes are tested.
 *
 * @param obj       - The root value to search.
 * @param predicate - Returns true for values to collect.
 */
export function collect(
  obj: unknown,
  predicate: (value: unknown, key: string | number, path: Path) => boolean
): unknown[] {
  const results: unknown[] = [];

  visit(obj, {
    enter(key, value, path) {
      if (predicate(value, key, path)) {
        results.push(value);
      }
    },
  });

  return results;
}
