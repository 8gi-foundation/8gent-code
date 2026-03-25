/**
 * object-schema.ts
 * Infers and validates object shapes for API evolution and runtime safety.
 */

export type SchemaType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "array"
  | "object"
  | "unknown";

export interface FieldSchema {
  type: SchemaType;
  nullable?: boolean;
  optional?: boolean;
  items?: FieldSchema;         // for array types
  properties?: ObjectSchema;  // for object types
}

export type ObjectSchema = Record<string, FieldSchema>;

export interface ShapeDiff {
  added: string[];
  removed: string[];
  changed: Record<string, { from: SchemaType; to: SchemaType }>;
}

function inferFieldSchema(value: unknown): FieldSchema {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };

  const t = typeof value;

  if (t === "string") return { type: "string" };
  if (t === "number") return { type: "number" };
  if (t === "boolean") return { type: "boolean" };

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array", items: { type: "unknown" } };
    // Infer from first non-null element
    const sample = value.find((v) => v !== null && v !== undefined) ?? value[0];
    return { type: "array", items: inferFieldSchema(sample) };
  }

  if (t === "object") {
    return {
      type: "object",
      properties: inferSchema(value as Record<string, unknown>),
    };
  }

  return { type: "unknown" };
}

/**
 * Infers a schema from a plain object.
 * Returns a flat or nested ObjectSchema depending on the input shape.
 */
export function inferSchema(obj: Record<string, unknown>): ObjectSchema {
  const schema: ObjectSchema = {};
  for (const [key, value] of Object.entries(obj)) {
    schema[key] = inferFieldSchema(value);
  }
  return schema;
}

/**
 * Validates that obj conforms to schema.
 * Returns true if all required fields match their expected types.
 * Optional fields (marked optional: true) may be absent.
 */
export function validateShape(
  obj: Record<string, unknown>,
  schema: ObjectSchema
): boolean {
  for (const [key, fieldSchema] of Object.entries(schema)) {
    const value = obj[key];

    if (!(key in obj)) {
      if (!fieldSchema.optional) return false;
      continue;
    }

    const actualType = inferFieldSchema(value).type;

    if (fieldSchema.nullable && value === null) continue;

    if (actualType !== fieldSchema.type) return false;

    // Recurse into nested objects
    if (
      fieldSchema.type === "object" &&
      fieldSchema.properties &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      if (!validateShape(value as Record<string, unknown>, fieldSchema.properties)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Returns true if obj contains at least the keys and types described in shape.
 * Extra keys on obj are allowed.
 */
export function hasShape(
  obj: Record<string, unknown>,
  shape: ObjectSchema
): boolean {
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!(key in obj)) return false;
    const actualType = inferFieldSchema(obj[key]).type;
    if (actualType !== fieldSchema.type) return false;
  }
  return true;
}

/**
 * Diffs two schemas and returns what was added, removed, or had its type changed.
 * Operates on top-level keys only (shallow diff).
 */
export function diffShapes(schemaA: ObjectSchema, schemaB: ObjectSchema): ShapeDiff {
  const keysA = new Set(Object.keys(schemaA));
  const keysB = new Set(Object.keys(schemaB));

  const added = [...keysB].filter((k) => !keysA.has(k));
  const removed = [...keysA].filter((k) => !keysB.has(k));
  const changed: ShapeDiff["changed"] = {};

  for (const key of keysA) {
    if (keysB.has(key) && schemaA[key].type !== schemaB[key].type) {
      changed[key] = { from: schemaA[key].type, to: schemaB[key].type };
    }
  }

  return { added, removed, changed };
}
