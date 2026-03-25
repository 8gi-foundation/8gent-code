/**
 * deep-merge.ts
 * Deep merges N objects with configurable array and conflict strategies.
 */

export type ArrayStrategy = "replace" | "concat" | "unique";

export interface DeepMergeOptions {
  /** How to handle arrays: replace (default), concat, or unique (deduplicated concat) */
  arrayStrategy?: ArrayStrategy;
  /** Per-key custom merge functions. Receives (existing, incoming) and returns merged value. */
  customMerge?: Record<string, (existing: unknown, incoming: unknown) => unknown>;
}

/**
 * Deep merges two or more objects. Later objects override earlier ones.
 * Handles circular references, configurable array strategies, and per-key custom merges.
 *
 * @example
 * deepMerge({ a: 1 }, { b: 2 })
 * // => { a: 1, b: 2 }
 *
 * deepMerge({ a: [1, 2] }, { a: [3] }, { arrayStrategy: "concat" })
 * // => { a: [1, 2, 3] }
 *
 * deepMerge({ a: [1, 2] }, { a: [2, 3] }, { arrayStrategy: "unique" })
 * // => { a: [1, 2, 3] }
 */
export function deepMerge<T extends object>(
  ...args: Partial<T>[] | [...Partial<T>[], DeepMergeOptions]
): T {
  let options: DeepMergeOptions = {};
  let objects: Partial<T>[];

  const last = args[args.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last) && isOptionsObject(last)) {
    options = last as DeepMergeOptions;
    objects = args.slice(0, -1) as Partial<T>[];
  } else {
    objects = args as Partial<T>[];
  }

  const { arrayStrategy = "replace", customMerge = {} } = options;
  const seen = new WeakSet<object>();

  function mergeTwo(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    for (const key of Object.keys(source)) {
      const existing = target[key];
      const incoming = source[key];

      // Per-key custom merge takes priority
      if (customMerge[key]) {
        target[key] = customMerge[key](existing, incoming);
        continue;
      }

      // Skip undefined - do not overwrite existing values with undefined
      if (incoming === undefined) continue;

      // Arrays
      if (Array.isArray(incoming)) {
        if (arrayStrategy === "replace" || !Array.isArray(existing)) {
          target[key] = [...incoming];
        } else if (arrayStrategy === "concat") {
          target[key] = [...(existing as unknown[]), ...incoming];
        } else {
          // unique: keep all objects, dedup primitives by value
          const combined = [...(existing as unknown[]), ...incoming];
          target[key] = combined.filter((v, i, arr) => {
            if (v !== null && typeof v === "object") return true;
            return arr.indexOf(v) === i;
          });
        }
        continue;
      }

      // Nested plain objects - recurse
      if (isPlainObject(incoming)) {
        if (seen.has(incoming as object)) {
          // Circular reference guard - assign as-is to break the cycle
          target[key] = incoming;
          continue;
        }
        seen.add(incoming as object);
        target[key] = mergeTwo(
          isPlainObject(existing) ? { ...(existing as Record<string, unknown>) } : {},
          incoming as Record<string, unknown>
        );
        seen.delete(incoming as object);
        continue;
      }

      // Primitive or non-plain value
      target[key] = incoming;
    }
    return target;
  }

  let result: Record<string, unknown> = {};
  for (const obj of objects) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    result = mergeTwo(result, obj as Record<string, unknown>);
  }

  return result as T;
}

// --- Helpers ---

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function isOptionsObject(val: unknown): val is DeepMergeOptions {
  if (!isPlainObject(val)) return false;
  return "arrayStrategy" in (val as object) || "customMerge" in (val as object);
}
