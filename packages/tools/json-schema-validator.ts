/**
 * JSON Schema Validator - Draft-07 subset
 * Supports: type, required, properties, items, enum, pattern, minimum, maximum,
 *           minLength, maxLength, minItems, maxItems, additionalProperties
 */

export interface SchemaDefinition {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaDefinition>;
  items?: SchemaDefinition;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | SchemaDefinition;
  description?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateNode(
  data: unknown,
  schema: SchemaDefinition,
  path: string,
  errors: ValidationError[]
): void {
  // type check
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeName(data);
    // JSON Schema treats "integer" as a number subtype
    const typeMatch = allowed.some(
      (t) =>
        t === actual ||
        (t === "integer" && actual === "number" && Number.isInteger(data))
    );
    if (!typeMatch) {
      errors.push({
        path,
        message: `Expected type ${allowed.join(" | ")}, got ${actual}`,
      });
      return; // further checks on wrong type are noisy
    }
  }

  // enum
  if (schema.enum !== undefined) {
    const match = schema.enum.some(
      (v) => JSON.stringify(v) === JSON.stringify(data)
    );
    if (!match) {
      errors.push({
        path,
        message: `Value must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
      });
    }
  }

  // string-specific
  if (typeof data === "string") {
    if (schema.pattern !== undefined) {
      if (!new RegExp(schema.pattern).test(data)) {
        errors.push({ path, message: `Does not match pattern: ${schema.pattern}` });
      }
    }
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({ path, message: `String too short: min ${schema.minLength}, got ${data.length}` });
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push({ path, message: `String too long: max ${schema.maxLength}, got ${data.length}` });
    }
  }

  // number-specific
  if (typeof data === "number") {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({ path, message: `Value ${data} is below minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({ path, message: `Value ${data} exceeds maximum ${schema.maximum}` });
    }
  }

  // object-specific
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({ path: path ? `${path}.${key}` : key, message: `Required property missing: ${key}` });
        }
      }
    }

    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validateNode(obj[key], subSchema, path ? `${path}.${key}` : key, errors);
        }
      }
    }

    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push({ path: path ? `${path}.${key}` : key, message: `Additional property not allowed: ${key}` });
        }
      }
    } else if (typeof schema.additionalProperties === "object") {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const [key, val] of Object.entries(obj)) {
        if (!known.has(key)) {
          validateNode(val, schema.additionalProperties as SchemaDefinition, path ? `${path}.${key}` : key, errors);
        }
      }
    }
  }

  // array-specific
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({ path, message: `Array too short: min ${schema.minItems}, got ${data.length}` });
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push({ path, message: `Array too long: max ${schema.maxItems}, got ${data.length}` });
    }
    if (schema.items) {
      data.forEach((item, i) => {
        validateNode(item, schema.items!, `${path}[${i}]`, errors);
      });
    }
  }
}

/**
 * Validate data against a JSON Schema draft-07 subset definition.
 * Returns { valid, errors } where errors is an array of { path, message }.
 */
export function validate(data: unknown, schema: SchemaDefinition): ValidationResult {
  const errors: ValidationError[] = [];
  validateNode(data, schema, "", errors);
  return { valid: errors.length === 0, errors };
}
