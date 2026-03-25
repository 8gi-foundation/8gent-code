/**
 * env-guard
 *
 * Validates required environment variables at startup.
 * Throws with all missing or invalid vars listed in one message.
 * Returns a typed config object when all constraints pass.
 */

export type EnvType = "string" | "number" | "boolean" | "url";

export interface EnvFieldSchema {
  /** Whether the variable must be present (default: true). */
  required?: boolean;
  /** Expected type. Parsed and coerced. Default: "string". */
  type?: EnvType;
  /** Default value used when the variable is absent and not required. */
  default?: string | number | boolean;
  /** Additional validation function. Return an error message string to fail, or null to pass. */
  validate?: (value: string) => string | null;
  /** Human-readable description for error messages. */
  description?: string;
}

export type EnvSchema = Record<string, EnvFieldSchema>;

type CoercedValue<T extends EnvFieldSchema> =
  T["type"] extends "number" ? number :
  T["type"] extends "boolean" ? boolean :
  string;

export type EnvConfig<S extends EnvSchema> = {
  [K in keyof S]: S[K]["required"] extends false
    ? CoercedValue<S[K]> | undefined
    : CoercedValue<S[K]>;
};

function coerce(raw: string, type: EnvType): string | number | boolean {
  switch (type) {
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`expected a number, got "${raw}"`);
      return n;
    }
    case "boolean": {
      const lower = raw.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return true;
      if (lower === "false" || lower === "0" || lower === "no") return false;
      throw new Error(`expected a boolean (true/false/1/0/yes/no), got "${raw}"`);
    }
    case "url": {
      try {
        new URL(raw);
      } catch {
        throw new Error(`expected a valid URL, got "${raw}"`);
      }
      return raw;
    }
    default:
      return raw;
  }
}

/**
 * Validate environment variables against a schema.
 * Collects all errors before throwing so the caller sees every problem at once.
 *
 * @example
 * const cfg = envGuard({
 *   PORT:        { type: "number", default: "3000" },
 *   DATABASE_URL: { type: "url", description: "Postgres connection string" },
 *   DEBUG:       { type: "boolean", required: false, default: "false" },
 * });
 * cfg.PORT        // number
 * cfg.DATABASE_URL // string (validated URL)
 * cfg.DEBUG       // boolean | undefined
 */
export function envGuard<S extends EnvSchema>(schema: S): EnvConfig<S> {
  const errors: string[] = [];
  const result: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(schema)) {
    const {
      required = true,
      type = "string",
      default: defaultValue,
      validate,
      description,
    } = field;

    const raw = process.env[key];

    if (raw === undefined || raw === "") {
      if (defaultValue !== undefined) {
        result[key] = defaultValue;
        continue;
      }
      if (!required) {
        result[key] = undefined;
        continue;
      }
      const hint = description ? ` (${description})` : "";
      errors.push(`  ${key}: missing required variable${hint}`);
      continue;
    }

    let coerced: string | number | boolean;
    try {
      coerced = coerce(raw, type);
    } catch (err) {
      errors.push(`  ${key}: ${(err as Error).message}`);
      continue;
    }

    if (validate) {
      const problem = validate(raw);
      if (problem) {
        errors.push(`  ${key}: ${problem}`);
        continue;
      }
    }

    result[key] = coerced;
  }

  if (errors.length > 0) {
    throw new Error(
      `Environment validation failed:\n${errors.join("\n")}`
    );
  }

  return result as EnvConfig<S>;
}

/**
 * Read a single env var, returning undefined if absent.
 *
 * @example
 * getEnv("NODE_ENV")          // "production" | undefined
 * getEnv("PORT", "number")    // 3000 | undefined
 */
export function getEnv(key: string): string | undefined;
export function getEnv(key: string, type: "number"): number | undefined;
export function getEnv(key: string, type: "boolean"): boolean | undefined;
export function getEnv(key: string, type: "url"): string | undefined;
export function getEnv(
  key: string,
  type: EnvType = "string"
): string | number | boolean | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  try {
    return coerce(raw, type);
  } catch {
    return undefined;
  }
}

/**
 * Read a single env var, throwing if absent or empty.
 *
 * @example
 * requireEnv("DATABASE_URL")              // throws if missing
 * requireEnv("MAX_RETRIES", "number")     // number or throws
 */
export function requireEnv(key: string, type?: EnvType): string | number | boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    throw new Error(`Required environment variable "${key}" is not set`);
  }
  return coerce(raw, type ?? "string");
}
