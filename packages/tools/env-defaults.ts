/**
 * env-defaults: typed defaults for environment variables
 *
 * Auto-coerces process.env values to string, number, boolean, JSON, or list.
 * Falls back to defaults when variables are absent or empty.
 *
 * Usage:
 *   import { env } from './env-defaults';
 *   const port = env.number('PORT', 3000);
 *   const debug = env.boolean('DEBUG', false);
 *   const tags = env.list('TAGS', ['default']);
 */

export class EnvMissingError extends Error {
  constructor(name: string) {
    super(`Required environment variable "${name}" is not set`);
    this.name = 'EnvMissingError';
  }
}

function raw(name: string): string | undefined {
  const val = process.env[name];
  if (val === undefined || val === '') return undefined;
  return val;
}

/**
 * Returns the raw string value of an env var, or a default.
 */
function string(name: string): string | undefined;
function string(name: string, defaultValue: string): string;
function string(name: string, defaultValue?: string): string | undefined {
  return raw(name) ?? defaultValue;
}

/**
 * Coerces env var to number. Returns NaN-safe default on bad input.
 */
function number(name: string): number | undefined;
function number(name: string, defaultValue: number): number;
function number(name: string, defaultValue?: number): number | undefined {
  const val = raw(name);
  if (val === undefined) return defaultValue;
  const n = Number(val);
  if (Number.isNaN(n)) {
    console.warn(`[env] "${name}" is not a valid number ("${val}"), using default: ${defaultValue}`);
    return defaultValue;
  }
  return n;
}

/**
 * Coerces env var to boolean.
 * Truthy: "1", "true", "yes", "on" (case-insensitive).
 * Falsy: "0", "false", "no", "off" (case-insensitive).
 */
function boolean(name: string): boolean | undefined;
function boolean(name: string, defaultValue: boolean): boolean;
function boolean(name: string, defaultValue?: boolean): boolean | undefined {
  const val = raw(name);
  if (val === undefined) return defaultValue;
  const lower = val.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  console.warn(`[env] "${name}" is not a valid boolean ("${val}"), using default: ${defaultValue}`);
  return defaultValue;
}

/**
 * Parses env var as JSON. Returns default on parse error.
 */
function json<T = unknown>(name: string): T | undefined;
function json<T = unknown>(name: string, defaultValue: T): T;
function json<T = unknown>(name: string, defaultValue?: T): T | undefined {
  const val = raw(name);
  if (val === undefined) return defaultValue;
  try {
    return JSON.parse(val) as T;
  } catch {
    console.warn(`[env] "${name}" is not valid JSON, using default`);
    return defaultValue;
  }
}

/**
 * Splits env var on commas (with optional whitespace trimming).
 * Returns default when variable is absent.
 */
function list(name: string): string[] | undefined;
function list(name: string, defaultValue: string[]): string[];
function list(name: string, defaultValue?: string[]): string[] | undefined {
  const val = raw(name);
  if (val === undefined) return defaultValue;
  return val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Returns the string value of an env var, throwing EnvMissingError if absent.
 */
function required(name: string): string {
  const val = raw(name);
  if (val === undefined) throw new EnvMissingError(name);
  return val;
}

export const env = {
  string,
  number,
  boolean,
  json,
  list,
  required,
};

export default env;
