/**
 * data-validator - fluent chainable data validation
 *
 * Usage:
 *   v.string().min(3).max(100).email().validate("user@example.com")
 *   v.number().min(0).max(100).integer().validate(42)
 *   v.array().of(v.string()).validate(["a", "b"])
 *   v.object({ name: v.string() }).validate({ name: "Eight" })
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

type Validator = { validate(value: unknown): ValidationResult };

// --- StringValidator ---

class StringValidator implements Validator {
  private rules: Array<(v: string) => string | null> = [];

  min(n: number): this {
    this.rules.push((v) =>
      v.length < n ? `must be at least ${n} characters` : null
    );
    return this;
  }

  max(n: number): this {
    this.rules.push((v) =>
      v.length > n ? `must be at most ${n} characters` : null
    );
    return this;
  }

  email(): this {
    this.rules.push((v) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "must be a valid email"
    );
    return this;
  }

  pattern(re: RegExp, message = "must match pattern"): this {
    this.rules.push((v) => (re.test(v) ? null : message));
    return this;
  }

  validate(value: unknown): ValidationResult {
    const errors: string[] = [];
    if (typeof value !== "string") {
      return { valid: false, errors: ["must be a string"] };
    }
    for (const rule of this.rules) {
      const err = rule(value);
      if (err) errors.push(err);
    }
    return { valid: errors.length === 0, errors };
  }
}

// --- NumberValidator ---

class NumberValidator implements Validator {
  private rules: Array<(v: number) => string | null> = [];

  min(n: number): this {
    this.rules.push((v) => (v < n ? `must be >= ${n}` : null));
    return this;
  }

  max(n: number): this {
    this.rules.push((v) => (v > n ? `must be <= ${n}` : null));
    return this;
  }

  integer(): this {
    this.rules.push((v) => (Number.isInteger(v) ? null : "must be an integer"));
    return this;
  }

  validate(value: unknown): ValidationResult {
    const errors: string[] = [];
    if (typeof value !== "number" || isNaN(value)) {
      return { valid: false, errors: ["must be a number"] };
    }
    for (const rule of this.rules) {
      const err = rule(value);
      if (err) errors.push(err);
    }
    return { valid: errors.length === 0, errors };
  }
}

// --- ArrayValidator ---

class ArrayValidator implements Validator {
  private itemValidator?: Validator;

  of(validator: Validator): this {
    this.itemValidator = validator;
    return this;
  }

  validate(value: unknown): ValidationResult {
    if (!Array.isArray(value)) {
      return { valid: false, errors: ["must be an array"] };
    }
    if (!this.itemValidator) return { valid: true, errors: [] };
    const errors: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const result = this.itemValidator.validate(value[i]);
      if (!result.valid) {
        errors.push(...result.errors.map((e) => `[${i}]: ${e}`));
      }
    }
    return { valid: errors.length === 0, errors };
  }
}

// --- ObjectValidator ---

class ObjectValidator implements Validator {
  constructor(private schema: Record<string, Validator>) {}

  validate(value: unknown): ValidationResult {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { valid: false, errors: ["must be an object"] };
    }
    const obj = value as Record<string, unknown>;
    const errors: string[] = [];
    for (const [key, validator] of Object.entries(this.schema)) {
      const result = validator.validate(obj[key]);
      if (!result.valid) {
        errors.push(...result.errors.map((e) => `${key}: ${e}`));
      }
    }
    return { valid: errors.length === 0, errors };
  }
}

// --- Entry point ---

export const v = {
  string: () => new StringValidator(),
  number: () => new NumberValidator(),
  array: () => new ArrayValidator(),
  object: (schema: Record<string, Validator>) => new ObjectValidator(schema),
};
