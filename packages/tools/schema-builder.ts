/**
 * schema-builder.ts
 * Fluent API for building JSON schemas with toJSONSchema() output.
 *
 * Usage:
 *   s.object({ name: s.string().min(1), age: s.number().min(0) })
 *   s.array(s.string())
 *   s.enum(['a', 'b'])
 *   s.string().optional()
 *   builder.toJSONSchema()
 */

export type JSONSchema = Record<string, unknown>;

// Base builder shared across all types
abstract class BaseBuilder<T extends BaseBuilder<T>> {
  _optional = false;
  protected _description?: string;

  optional(): T {
    this._optional = true;
    return this as unknown as T;
  }

  describe(text: string): T {
    this._description = text;
    return this as unknown as T;
  }

  abstract toJSONSchema(): JSONSchema;

  protected applyShared(schema: JSONSchema): JSONSchema {
    if (this._description) schema.description = this._description;
    return schema;
  }
}

// String
class StringBuilder extends BaseBuilder<StringBuilder> {
  private _min?: number;
  private _max?: number;
  private _pattern?: string;

  min(n: number): StringBuilder { this._min = n; return this; }
  max(n: number): StringBuilder { this._max = n; return this; }
  pattern(p: string): StringBuilder { this._pattern = p; return this; }

  toJSONSchema(): JSONSchema {
    const schema: JSONSchema = { type: 'string' };
    if (this._min !== undefined) schema.minLength = this._min;
    if (this._max !== undefined) schema.maxLength = this._max;
    if (this._pattern) schema.pattern = this._pattern;
    return this.applyShared(schema);
  }
}

// Number
class NumberBuilder extends BaseBuilder<NumberBuilder> {
  private _min?: number;
  private _max?: number;
  private _integer = false;

  min(n: number): NumberBuilder { this._min = n; return this; }
  max(n: number): NumberBuilder { this._max = n; return this; }
  integer(): NumberBuilder { this._integer = true; return this; }

  toJSONSchema(): JSONSchema {
    const schema: JSONSchema = { type: this._integer ? 'integer' : 'number' };
    if (this._min !== undefined) schema.minimum = this._min;
    if (this._max !== undefined) schema.maximum = this._max;
    return this.applyShared(schema);
  }
}

// Boolean
class BooleanBuilder extends BaseBuilder<BooleanBuilder> {
  toJSONSchema(): JSONSchema {
    return this.applyShared({ type: 'boolean' });
  }
}

// Enum
class EnumBuilder extends BaseBuilder<EnumBuilder> {
  constructor(private values: (string | number | boolean)[]) { super(); }

  toJSONSchema(): JSONSchema {
    return this.applyShared({ enum: this.values });
  }
}

// Array
class ArrayBuilder extends BaseBuilder<ArrayBuilder> {
  private _minItems?: number;
  private _maxItems?: number;

  constructor(private items: BaseBuilder<any>) { super(); }

  minItems(n: number): ArrayBuilder { this._minItems = n; return this; }
  maxItems(n: number): ArrayBuilder { this._maxItems = n; return this; }

  toJSONSchema(): JSONSchema {
    const schema: JSONSchema = { type: 'array', items: this.items.toJSONSchema() };
    if (this._minItems !== undefined) schema.minItems = this._minItems;
    if (this._maxItems !== undefined) schema.maxItems = this._maxItems;
    return this.applyShared(schema);
  }
}

// Object
type Shape = Record<string, BaseBuilder<any>>;

class ObjectBuilder extends BaseBuilder<ObjectBuilder> {
  constructor(private shape: Shape) { super(); }

  toJSONSchema(): JSONSchema {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];

    for (const [key, builder] of Object.entries(this.shape)) {
      properties[key] = builder.toJSONSchema();
      if (!builder._optional) required.push(key);
    }

    const schema: JSONSchema = { type: 'object', properties };
    if (required.length > 0) schema.required = required;
    return this.applyShared(schema);
  }
}

// Public factory
export const s = {
  string: () => new StringBuilder(),
  number: () => new NumberBuilder(),
  boolean: () => new BooleanBuilder(),
  enum: (values: (string | number | boolean)[]) => new EnumBuilder(values),
  array: (items: BaseBuilder<any>) => new ArrayBuilder(items),
  object: (shape: Shape) => new ObjectBuilder(shape),
};

export type SchemaBuilder = typeof s;
