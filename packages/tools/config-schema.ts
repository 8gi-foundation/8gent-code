/**
 * Typed configuration schema with defaults, validation, type coercion,
 * and environment variable mapping for agent configuration.
 */

// --- Types ---

type SchemaType = "string" | "number" | "boolean" | "string[]";

interface FieldSchema<T> {
  type: SchemaType;
  default?: T;
  required?: boolean;
  env?: string;
  description?: string;
  validate?: (value: T) => string | null; // returns error message or null
}

type Schema = Record<string, FieldSchema<unknown>>;

type InferType<S extends FieldSchema<unknown>> =
  S["type"] extends "string" ? string :
  S["type"] extends "number" ? number :
  S["type"] extends "boolean" ? boolean :
  S["type"] extends "string[]" ? string[] :
  never;

type InferConfig<S extends Schema> = {
  [K in keyof S]: InferType<S[K]>;
};

export interface ConfigResult<T> {
  config: T;
  errors: string[];
  valid: boolean;
}

// --- Coercion ---

function coerce(value: unknown, type: SchemaType): unknown {
  if (value === undefined || value === null) return undefined;

  switch (type) {
    case "string":
      return String(value);
    case "number": {
      const n = Number(value);
      return isNaN(n) ? undefined : n;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "1" || value === "yes") return true;
      if (value === "false" || value === "0" || value === "no") return false;
      return undefined;
    case "string[]":
      if (Array.isArray(value)) return value.map(String);
      if (typeof value === "string") return value.split(",").map((s) => s.trim());
      return undefined;
  }
}

// --- Core ---

/**
 * Define a typed config schema. Returns the schema as-is for type inference;
 * actual processing happens in parseConfig.
 */
export function defineConfig<S extends Schema>(schema: S): S {
  return schema;
}

/**
 * Parse a config from a source object, merging env vars and applying defaults.
 * Returns a typed result with the parsed config and any validation errors.
 */
export function parseConfig<S extends Schema>(
  schema: S,
  source: Record<string, unknown> = {}
): ConfigResult<InferConfig<S>> {
  const config: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, field] of Object.entries(schema)) {
    let raw: unknown = source[key];

    // Check env var override
    if (field.env) {
      const envVal = process.env[field.env];
      if (envVal !== undefined) raw = envVal;
    }

    // Coerce
    let value = raw !== undefined ? coerce(raw, field.type) : undefined;

    // Fall back to default
    if (value === undefined && field.default !== undefined) {
      value = field.default;
    }

    // Required check
    if (value === undefined) {
      if (field.required) {
        const hint = field.env ? ` (or set env var ${field.env})` : "";
        errors.push(`"${key}" is required${hint}`);
      }
      continue;
    }

    // Type validation: coerce returning undefined means bad value
    const coerced = coerce(raw, field.type);
    if (raw !== undefined && coerced === undefined) {
      errors.push(`"${key}" could not be coerced to ${field.type}`);
      continue;
    }

    // Custom validator
    if (field.validate) {
      const err = (field.validate as (v: unknown) => string | null)(value);
      if (err) {
        errors.push(`"${key}": ${err}`);
        continue;
      }
    }

    config[key] = value;
  }

  return {
    config: config as InferConfig<S>,
    errors,
    valid: errors.length === 0,
  };
}

/**
 * Parse config from environment variables only (no source object).
 */
export function parseConfigFromEnv<S extends Schema>(
  schema: S
): ConfigResult<InferConfig<S>> {
  return parseConfig(schema, {});
}
