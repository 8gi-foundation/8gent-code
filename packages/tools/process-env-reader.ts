/**
 * process-env-reader.ts
 *
 * Structured, typed reader for process.env. Avoids scattered raw
 * `process.env.FOO` access and eliminates runtime surprises from
 * missing or malformed values.
 */

export class EnvReader {
  private readonly source: NodeJS.ProcessEnv;

  constructor(source: NodeJS.ProcessEnv = process.env) {
    this.source = source;
  }

  // ----------------------------------------------------------------
  // Primitives
  // ----------------------------------------------------------------

  /** Return raw string value, or `defaultValue` if the key is absent. */
  getString(key: string, defaultValue?: string): string | undefined {
    const val = this.source[key];
    if (val !== undefined) return val;
    return defaultValue;
  }

  /**
   * Parse value as a base-10 integer or float.
   * Returns `defaultValue` (or undefined) when absent or non-numeric.
   */
  getNumber(key: string, defaultValue?: number): number | undefined {
    const raw = this.source[key];
    if (raw === undefined) return defaultValue;
    const n = Number(raw);
    if (Number.isNaN(n)) return defaultValue;
    return n;
  }

  /**
   * Parse value as a boolean.
   * Truthy strings: "1", "true", "yes", "on" (case-insensitive).
   * All other non-empty values are falsy.
   * Returns `defaultValue` when the key is absent.
   */
  getBool(key: string, defaultValue?: boolean): boolean | undefined {
    const raw = this.source[key];
    if (raw === undefined) return defaultValue;
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
  }

  /**
   * Parse value as JSON.
   * Returns `defaultValue` on absent key or parse failure.
   */
  getJSON<T = unknown>(key: string, defaultValue?: T): T | undefined {
    const raw = this.source[key];
    if (raw === undefined) return defaultValue;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  }

  /**
   * Split value into a trimmed string array.
   * Default separator is comma. Empty items are dropped.
   * Returns `defaultValue` (or empty array) when the key is absent.
   */
  getList(
    key: string,
    separator: string = ",",
    defaultValue: string[] = []
  ): string[] {
    const raw = this.source[key];
    if (raw === undefined) return defaultValue;
    return raw
      .split(separator)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // ----------------------------------------------------------------
  // Guards
  // ----------------------------------------------------------------

  /**
   * Require a key to be present and non-empty.
   * Throws a descriptive error rather than silently returning undefined.
   */
  require(key: string): string {
    const val = this.source[key];
    if (val === undefined || val === "") {
      throw new Error(
        `[EnvReader] Required environment variable "${key}" is not set.`
      );
    }
    return val;
  }

  // ----------------------------------------------------------------
  // Environment detection helpers
  // ----------------------------------------------------------------

  /** True when NODE_ENV is "development" or absent (local default). */
  isDev(): boolean {
    const env = this.source["NODE_ENV"];
    return env === "development" || env === undefined;
  }

  /** True when NODE_ENV is "production". */
  isProd(): boolean {
    return this.source["NODE_ENV"] === "production";
  }

  /** True when NODE_ENV is "test". */
  isTest(): boolean {
    return this.source["NODE_ENV"] === "test";
  }
}

/** Singleton reader backed by the real process.env. */
export const env = new EnvReader();
