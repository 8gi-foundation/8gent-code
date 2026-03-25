/**
 * config-merge.ts
 *
 * Deep merge config objects with environment variable overrides, defaults,
 * and optional immutable freeze. All functions are pure and side-effect-free
 * except freeze(), which calls Object.freeze recursively.
 */

type ConfigValue = string | number | boolean | null | ConfigObject | ConfigValue[];
interface ConfigObject {
  [key: string]: ConfigValue;
}

function isPlainObject(value: unknown): value is ConfigObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepClone) as unknown as T;
  if (isPlainObject(value)) {
    const result: ConfigObject = {};
    for (const key of Object.keys(value)) {
      result[key] = deepClone((value as ConfigObject)[key]);
    }
    return result as unknown as T;
  }
  return value;
}

function deepMergeTwo(base: ConfigObject, override: ConfigObject): ConfigObject {
  const result: ConfigObject = deepClone(base);
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMergeTwo(baseVal, overVal);
    } else {
      result[key] = deepClone(overVal);
    }
  }
  return result;
}

function parsePath(path: string): string[] {
  return path.split(".");
}

function setNestedValue(obj: ConfigObject, keys: string[], value: ConfigValue): void {
  const [head, ...tail] = keys;
  if (tail.length === 0) {
    obj[head] = value;
    return;
  }
  if (!isPlainObject(obj[head])) {
    obj[head] = {};
  }
  setNestedValue(obj[head] as ConfigObject, tail, value);
}

function coerceEnvValue(raw: string): ConfigValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const num = Number(raw);
  if (!Number.isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

/**
 * Deep merge one or more override configs onto a base config.
 * Later overrides win. Arrays are replaced, not merged.
 */
export function mergeConfigs<T extends ConfigObject>(base: T, ...overrides: Partial<T>[]): T {
  let result: ConfigObject = deepClone(base);
  for (const override of overrides) {
    result = deepMergeTwo(result, override as ConfigObject);
  }
  return result as T;
}

/**
 * Map environment variables with a given prefix into nested config paths.
 * Variable names are lowercased and double underscores become dots.
 *
 * PREFIX_DATABASE__HOST=localhost  ->  config.database.host = "localhost"
 * PREFIX_PORT=3000                 ->  config.port = 3000
 */
export function withEnvOverrides<T extends ConfigObject>(
  config: T,
  prefix: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): T {
  const upper = prefix.toUpperCase() + "_";
  const overrides: ConfigObject = {};

  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith(upper) || rawValue === undefined) continue;
    const stripped = key.slice(upper.length).toLowerCase();
    const path = parsePath(stripped.replace(/__/g, "."));
    setNestedValue(overrides, path, coerceEnvValue(rawValue));
  }

  return mergeConfigs(config, overrides as Partial<T>);
}

/**
 * Fill in missing keys from a defaults object without overwriting existing values.
 */
export function withDefaults<T extends ConfigObject>(config: T, defaults: Partial<T>): T {
  return mergeConfigs(defaults as T, config);
}

/**
 * Recursively freeze a config object so it cannot be mutated at runtime.
 * Returns the same reference (frozen in-place) for convenience.
 */
export function freeze<T extends ConfigObject>(config: T): Readonly<T> {
  for (const value of Object.values(config)) {
    if (isPlainObject(value)) freeze(value);
    else if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isPlainObject(item)) freeze(item);
      });
      Object.freeze(value);
    }
  }
  return Object.freeze(config);
}
