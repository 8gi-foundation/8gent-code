/**
 * schema-validator.ts
 * Zero-dependency JSON schema validator for 8gent tools.
 *
 * Supports: types, required fields, patterns, min/max (numbers + string length),
 * minItems/maxItems (arrays), enum, nested objects, and array item schemas.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface SchemaField {
  type?: SchemaType | SchemaType[];
  required?: boolean;
  /** Regex pattern - applied to string values */
  pattern?: string;
  /** Minimum numeric value OR minimum string length (when type is "string") */
  min?: number;
  /** Maximum numeric value OR maximum string length (when type is "string") */
  max?: number;
  /** Minimum array length */
  minItems?: number;
  /** Maximum array length */
  maxItems?: number;
  /** Allowed values (enum) */
  enum?: unknown[];
  /** Nested object properties */
  properties?: Record<string, SchemaField>;
  /** Schema applied to every item in an array */
  items?: SchemaField;
  /** Human-readable description */
  description?: string;
}

export interface Schema {
  type?: SchemaType | SchemaType[];
  required?: string[];
  properties?: Record<string, SchemaField>;
  items?: SchemaField;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function typesOf(t: SchemaType | SchemaType[] | undefined): SchemaType[] {
  if (t === undefined) return [];
  return Array.isArray(t) ? t : [t];
}

function jsType(value: unknown): SchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  return t as SchemaType;
}

function matchesType(value: unknown, allowed: SchemaType[]): boolean {
  if (allowed.length === 0) return true;
  const actual = jsType(value);
  return allowed.some((a) => {
    if (a === "number") return actual === "number" || actual === "integer";
    return a === actual;
  });
}

function validateField(
  value: unknown,
  field: SchemaField,
  path: string,
  errors: ValidationError[]
): void {
  const types = typesOf(field.type);

  // Type check
  if (types.length > 0 && !matchesType(value, types)) {
    errors.push({
      path,
      message: `Expected type ${types.join(" | ")}, got ${jsType(value)}`,
    });
    return; // further checks are meaningless if type is wrong
  }

  // Null short-circuit - no further constraints apply
  if (value === null) return;

  // Enum
  if (field.enum !== undefined) {
    if (!field.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
      errors.push({
        path,
        message: `Value must be one of [${field.enum.map((e) => JSON.stringify(e)).join(", ")}]`,
      });
    }
  }

  // String-specific
  if (typeof value === "string") {
    if (field.pattern !== undefined) {
      const re = new RegExp(field.pattern);
      if (!re.test(value)) {
        errors.push({ path, message: `Value does not match pattern /${field.pattern}/` });
      }
    }
    if (field.min !== undefined && value.length < field.min) {
      errors.push({ path, message: `String length ${value.length} is less than min ${field.min}` });
    }
    if (field.max !== undefined && value.length > field.max) {
      errors.push({ path, message: `String length ${value.length} exceeds max ${field.max}` });
    }
  }

  // Number-specific
  if (typeof value === "number") {
    if (field.min !== undefined && value < field.min) {
      errors.push({ path, message: `Value ${value} is less than min ${field.min}` });
    }
    if (field.max !== undefined && value > field.max) {
      errors.push({ path, message: `Value ${value} exceeds max ${field.max}` });
    }
  }

  // Array-specific
  if (Array.isArray(value)) {
    if (field.minItems !== undefined && value.length < field.minItems) {
      errors.push({ path, message: `Array length ${value.length} is less than minItems ${field.minItems}` });
    }
    if (field.maxItems !== undefined && value.length > field.maxItems) {
      errors.push({ path, message: `Array length ${value.length} exceeds maxItems ${field.maxItems}` });
    }
    if (field.items !== undefined) {
      value.forEach((item, i) => {
        validateField(item, field.items!, `${path}[${i}]`, errors);
      });
    }
  }

  // Object-specific (nested properties)
  if (typeof value === "object" && !Array.isArray(value) && value !== null) {
    const obj = value as Record<string, unknown>;
    if (field.properties) {
      // Required fields from property definitions
      for (const [key, propSchema] of Object.entries(field.properties)) {
        const childPath = path ? `${path}.${key}` : key;
        if (propSchema.required && !(key in obj)) {
          errors.push({ path: childPath, message: `Required field missing` });
          continue;
        }
        if (key in obj) {
          validateField(obj[key], propSchema, childPath, errors);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a JSON value against a schema.
 *
 * @example
 * const result = validate({ name: "Eight", age: 1 }, schema);
 * if (!result.valid) console.error(result.errors);
 */
export function validate(data: unknown, schema: Schema): ValidationResult {
  const errors: ValidationError[] = [];

  // Top-level type
  const types = typesOf(schema.type);
  if (types.length > 0 && !matchesType(data, types)) {
    errors.push({
      path: "",
      message: `Expected type ${types.join(" | ")}, got ${jsType(data)}`,
    });
    return { valid: false, errors };
  }

  // Top-level array
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({ path: "", message: `Array length ${data.length} is less than minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push({ path: "", message: `Array length ${data.length} exceeds maxItems ${schema.maxItems}` });
    }
    if (schema.items !== undefined) {
      data.forEach((item, i) => {
        validateField(item, schema.items!, `[${i}]`, errors);
      });
    }
    return { valid: errors.length === 0, errors };
  }

  // Top-level object
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;

    // Required array at schema level
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({ path: key, message: `Required field missing` });
        }
      }
    }

    // Properties
    if (schema.properties) {
      for (const [key, fieldSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validateField(obj[key], fieldSchema, key, errors);
        } else if (fieldSchema.required) {
          errors.push({ path: key, message: `Required field missing` });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build a Schema object from a plain definition.
 * Convenience wrapper - no transformation needed, just types it correctly.
 *
 * @example
 * const schema = createSchema({
 *   type: "object",
 *   required: ["name"],
 *   properties: {
 *     name: { type: "string", min: 1, max: 100 },
 *     age:  { type: "integer", min: 0, max: 150 },
 *   },
 * });
 */
export function createSchema(definition: Schema): Schema {
  return definition;
}
