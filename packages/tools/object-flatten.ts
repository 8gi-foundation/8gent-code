/**
 * Flatten nested objects to dot-notation keys and unflatten back.
 * Zero dependencies.
 */

export function flatten(
  obj: Record<string, any>,
  separator = ".",
  prefix = "",
  result: Record<string, any> = {}
): Record<string, any> {
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}${separator}${key}` : key;
    const val = obj[key];

    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      Object.keys(val).length > 0
    ) {
      flatten(val, separator, fullKey, result);
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

export function unflatten(
  obj: Record<string, any>,
  separator = "."
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const flatKey of Object.keys(obj)) {
    const parts = flatKey.split(separator);
    let cursor: Record<string, any> = result;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (cursor[part] === undefined || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }

    cursor[parts[parts.length - 1]] = obj[flatKey];
  }

  return result;
}
