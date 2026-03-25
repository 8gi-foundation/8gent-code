/**
 * JSON structure transformer.
 * Transforms JSON objects using mapping rules, path remapping, reshaping,
 * and field picking/omitting. Zero dependencies, pure TypeScript.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type TransformFn = (value: JsonValue) => JsonValue;

interface TransformRule {
  from: string;
  to: string;
  fn?: TransformFn;
}

/**
 * Get a value from a nested object using dot-notation path.
 * Returns undefined if path does not exist.
 */
function getPath(obj: JsonObject, path: string): JsonValue | undefined {
  const parts = path.split(".");
  let current: JsonValue = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as JsonObject)[part];
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Set a value on a nested object using dot-notation path.
 * Creates intermediate objects as needed.
 */
function setPath(obj: JsonObject, path: string, value: JsonValue): void {
  const parts = path.split(".");
  let current: JsonObject = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as JsonObject;
  }
  current[parts[parts.length - 1]] = value;
}

/**
 * Transform a JSON object using an array of mapping rules.
 * Each rule maps a source path to a dest path with an optional transform fn.
 * Only mapped paths are included in the output.
 */
export function transform(data: JsonObject, rules: TransformRule[]): JsonObject {
  const result: JsonObject = {};
  for (const rule of rules) {
    const value = getPath(data, rule.from);
    if (value !== undefined) {
      const mapped = rule.fn ? rule.fn(value) : value;
      setPath(result, rule.to, mapped);
    }
  }
  return result;
}

/**
 * Rename top-level keys in a flat object.
 * mapping is { oldKey: newKey }. Unmapped keys are carried through unchanged.
 */
export function rename(data: JsonObject, mapping: Record<string, string>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    const newKey = mapping[key] ?? key;
    result[newKey] = value;
  }
  return result;
}

/**
 * Reshape a JSON object using a template.
 * Template values that are strings starting with "$" are treated as source paths
 * (without the "$" prefix). All other template values are used as literals.
 */
export function reshape(data: JsonObject, template: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const [key, tplValue] of Object.entries(template)) {
    if (typeof tplValue === "string" && tplValue.startsWith("$")) {
      const sourcePath = tplValue.slice(1);
      const resolved = getPath(data, sourcePath);
      result[key] = resolved !== undefined ? resolved : null;
    } else if (tplValue !== null && typeof tplValue === "object" && !Array.isArray(tplValue)) {
      result[key] = reshape(data, tplValue as JsonObject);
    } else {
      result[key] = tplValue;
    }
  }
  return result;
}

/**
 * Pick only the specified dot-notation paths from a JSON object.
 * Returns a new object containing only those paths.
 */
export function pick(data: JsonObject, paths: string[]): JsonObject {
  const result: JsonObject = {};
  for (const path of paths) {
    const value = getPath(data, path);
    if (value !== undefined) {
      setPath(result, path, value);
    }
  }
  return result;
}

/**
 * Omit the specified top-level keys from a JSON object.
 * Returns a shallow copy with those keys removed.
 */
export function omit(data: JsonObject, keys: string[]): JsonObject {
  const excluded = new Set(keys);
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    if (!excluded.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
