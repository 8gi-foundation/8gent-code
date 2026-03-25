/**
 * Config Validator - validates config objects against rule sets with helpful errors.
 * Supports nested paths, type checking, required fields, defaults, env overrides.
 */

export type FieldType = "string" | "number" | "boolean" | "array" | "object";

export interface FieldRule {
  type: FieldType;
  required?: boolean;
  default?: unknown;
  validate?: (value: unknown) => boolean | string;
  env?: string;
  description?: string;
}

export type RuleSet = Record<string, FieldRule>;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalized: Record<string, unknown>;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (
      current[part] === null ||
      current[part] === undefined ||
      typeof current[part] !== "object"
    ) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

function checkType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !isNaN(value as number);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
  }
}

function coerceFromEnv(raw: string, type: FieldType): unknown {
  switch (type) {
    case "number":
      return Number(raw);
    case "boolean":
      return raw === "true" || raw === "1";
    case "array":
      try {
        return JSON.parse(raw);
      } catch {
        return raw.split(",").map((s) => s.trim());
      }
    case "object":
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    default:
      return raw;
  }
}

/**
 * Define a typed rule set. Provides a typed helper for authoring rules.
 */
export function defineRules<T extends RuleSet>(rules: T): T {
  return rules;
}

/**
 * Validate a config object against a set of field rules.
 * Returns valid flag, error/warning lists, and a normalized config with defaults applied.
 */
export function validateConfig(
  config: Record<string, unknown>,
  rules: RuleSet
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalized: Record<string, unknown> = JSON.parse(
    JSON.stringify(config)
  );

  for (const [field, rule] of Object.entries(rules)) {
    let value = getNestedValue(normalized, field);

    // Env override takes highest precedence
    if (rule.env) {
      const envRaw = process.env[rule.env];
      if (envRaw !== undefined) {
        const coerced = coerceFromEnv(envRaw, rule.type);
        if (coerced !== undefined) {
          setNestedValue(normalized, field, coerced);
          value = coerced;
        } else {
          warnings.push(
            `Field "${field}": env var ${rule.env}="${envRaw}" could not be coerced to ${rule.type}, ignoring`
          );
        }
      }
    }

    // Apply default if value is missing
    if (value === undefined || value === null) {
      if (rule.default !== undefined) {
        setNestedValue(normalized, field, rule.default);
        value = rule.default;
        warnings.push(
          `Field "${field}": missing, using default (${JSON.stringify(rule.default)})`
        );
      } else if (rule.required) {
        errors.push(
          `Field "${field}" is required but missing` +
            (rule.description ? ` — ${rule.description}` : "")
        );
        continue;
      } else {
        continue;
      }
    }

    // Type check
    if (!checkType(value, rule.type)) {
      errors.push(
        `Field "${field}": expected ${rule.type}, got ${Array.isArray(value) ? "array" : typeof value} (value: ${JSON.stringify(value)})`
      );
      continue;
    }

    // Custom validate
    if (rule.validate) {
      const result = rule.validate(value);
      if (result !== true) {
        const msg =
          typeof result === "string"
            ? result
            : `Field "${field}" failed custom validation`;
        errors.push(msg);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, normalized };
}
