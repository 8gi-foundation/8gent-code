/**
 * Gets an environment variable with type-safe validation.
 * @param key The environment variable key.
 * @returns An EnvValue instance with validation methods.
 */
function env(key: string): EnvValue {
  return new EnvValue(key);
}

/**
 * Represents an environment variable with validation methods.
 */
class EnvValue {
  private key: string;
  private value: string | undefined;
  private errors: string[] = [];
  private defaultVal: any;
  private customValidator: ((val: any) => boolean) | undefined;

  constructor(key: string) {
    this.key = key;
    this.value = process.env[key];
  }

  /**
   * Validates that the value is a string.
   * @returns This instance for chaining.
   */
  string(): this {
    if (typeof this.value !== 'string') {
      this.errors.push(`Expected string for ${this.key}`);
    }
    return this;
  }

  /**
   * Validates that the value is a number.
   * @returns This instance for chaining.
   */
  number(): this {
    if (isNaN(Number(this.value))) {
      this.errors.push(`Expected number for ${this.key}`);
    }
    return this;
  }

  /**
   * Validates that the value is a boolean.
   * @returns This instance for chaining.
   */
  boolean(): this {
    if (this.value !== 'true' && this.value !== 'false') {
      this.errors.push(`Expected boolean for ${this.key}`);
    }
    return this;
  }

  /**
   * Validates that the value is required.
   * @returns This instance for chaining.
   */
  required(): this {
    if (!this.value) {
      this.errors.push(`${this.key} is required`);
    }
    return this;
  }

  /**
   * Sets a default value if the environment variable is missing.
   * @param val The default value.
   * @returns This instance for chaining.
   */
  default(val: any): this {
    this.defaultVal = val;
    return this;
  }

  /**
   * Applies a custom validation function.
   * @param fn The validation function.
   * @returns This instance for chaining.
   */
  validate(fn: (val: any) => boolean): this {
    this.customValidator = fn;
    return this;
  }

  /**
   * Retrieves the validated value or throws an error.
   * @returns The validated value.
   */
  get(): any {
    let val = this.value;
    if (!val && this.defaultVal !== undefined) {
      val = this.defaultVal;
    }

    if (this.customValidator && !this.customValidator(val)) {
      this.errors.push(`Custom validation failed for ${this.key}`);
    }

    if (this.errors.length > 0) {
      throw new Error(this.errors.join('\n'));
    }

    return val;
  }
}

// Load .env file
function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const data = fs.readFileSync(envPath, 'utf-8');
    const lines = data.split('\n');
    for (const line of lines) {
      const [key, val] = line.split('=');
      if (key && val) {
        process.env[key.trim()] = val.trim();
      }
    }
  }
}

loadEnv();

export { env };