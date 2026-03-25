/**
 * Lightweight JSON schema validator - no external dependencies.
 * Checks types, required fields, enum values, and nested objects.
 */

export interface SchemaNode {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateNode(
  value: unknown,
  schema: SchemaNode,
  path: string,
  errors: ValidationError[],
): void {
  // Type check
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    if (actual !== schema.type) {
      errors.push({ path, message: `expected ${schema.type}, got ${actual}` });
      return; // no point checking further if type is wrong
    }
  }

  // Enum check
  if (schema.enum !== undefined) {
    const match = schema.enum.some(
      (e) => JSON.stringify(e) === JSON.stringify(value),
    );
    if (!match) {
      errors.push({
        path,
        message: `value must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`,
      });
    }
  }

  // String constraints
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `string length must be >= ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `string length must be <= ${schema.maxLength}` });
    }
  }

  // Number constraints
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `value must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `value must be <= ${schema.maximum}` });
    }
  }

  // Object - required fields and nested properties
  if (typeOf(value) === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;

    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({ path: path ? `${path}.${key}` : key, message: 'required field missing' });
        }
      }
    }

    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const childPath = path ? `${path}.${key}` : key;
          validateNode(obj[key], propSchema, childPath, errors);
        }
      }
    }
  }

  // Array - validate each item against items schema
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validateNode(value[i], schema.items, `${path}[${i}]`, errors);
    }
  }
}

export function validate(data: unknown, schema: SchemaNode): ValidationResult {
  const errors: ValidationError[] = [];
  validateNode(data, schema, '', errors);
  return { valid: errors.length === 0, errors };
}
