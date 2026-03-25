/**
 * RFC 7396 JSON Merge Patch
 * https://www.rfc-editor.org/rfc/rfc7396
 *
 * A merge patch document describes changes to a target JSON document.
 * - If a key has a value: set that key on the target
 * - If a key is null: remove that key from the target
 * - If the patch is not an object: replace the target entirely
 */

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return (value as JsonValue[]).map(deepClone) as T;
  const clone: JsonObject = {};
  for (const key of Object.keys(value as JsonObject)) {
    clone[key] = deepClone((value as JsonObject)[key]);
  }
  return clone as T;
}

/**
 * Apply a RFC 7396 merge patch to a target document.
 * Mutates and returns the target. Use applyMergePatch for an immutable version.
 */
export function mergePatch(target: JsonValue, patch: JsonValue): JsonValue {
  if (!isObject(patch)) {
    return deepClone(patch);
  }

  const result: JsonObject = isObject(target)
    ? (deepClone(target) as JsonObject)
    : {};

  for (const key of Object.keys(patch as JsonObject)) {
    const patchVal = (patch as JsonObject)[key];
    if (patchVal === null) {
      delete result[key];
    } else if (isObject(patchVal) && isObject(result[key])) {
      result[key] = mergePatch(result[key], patchVal) as JsonObject;
    } else {
      result[key] = deepClone(patchVal);
    }
  }

  return result;
}

/**
 * Immutable version of mergePatch. Returns a new object; does not mutate target.
 */
export function applyMergePatch(target: JsonValue, patch: JsonValue): JsonValue {
  return mergePatch(deepClone(target), patch);
}

/**
 * Generate a RFC 7396 merge patch that transforms `original` into `modified`.
 * Keys present in original but absent in modified become null (deletion markers).
 * Keys with equal values are omitted from the patch.
 */
export function generateMergePatch(
  original: JsonValue,
  modified: JsonValue
): JsonValue {
  if (!isObject(original) || !isObject(modified)) {
    if (JSON.stringify(original) === JSON.stringify(modified)) {
      return {};
    }
    return deepClone(modified);
  }

  const patch: JsonObject = {};
  const allKeys = new Set([
    ...Object.keys(original as JsonObject),
    ...Object.keys(modified as JsonObject),
  ]);

  for (const key of allKeys) {
    const origVal = (original as JsonObject)[key];
    const modVal = (modified as JsonObject)[key];

    if (!(key in (modified as JsonObject))) {
      // Key removed - signal deletion with null
      patch[key] = null;
    } else if (!(key in (original as JsonObject))) {
      // Key added
      patch[key] = deepClone(modVal);
    } else if (isObject(origVal) && isObject(modVal)) {
      // Recurse into nested objects
      const nested = generateMergePatch(origVal, modVal);
      if (isObject(nested) && Object.keys(nested).length > 0) {
        patch[key] = nested;
      }
    } else if (JSON.stringify(origVal) !== JSON.stringify(modVal)) {
      // Scalar or array changed
      patch[key] = deepClone(modVal);
    }
    // Equal values are skipped (not included in patch)
  }

  return patch;
}
