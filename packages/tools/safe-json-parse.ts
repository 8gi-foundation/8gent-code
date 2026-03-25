/**
 * safe-json-parse - Non-throwing JSON parse with Result type and schema validation.
 *
 * All functions return structured results instead of throwing.
 */

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type Ok<T> = { ok: true; data: T; error: undefined };
export type Err = { ok: false; data: undefined; error: string };
export type Result<T> = Ok<T> | Err;

function ok<T>(data: T): Ok<T> {
  return { ok: true, data, error: undefined };
}

function err(message: string): Err {
  return { ok: false, data: undefined, error: message };
}

// ---------------------------------------------------------------------------
// safeParse
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string. Returns {ok: true, data} on success, {ok: false, error} on failure.
 * Never throws.
 */
export function safeParse(str: string): Result<unknown> {
  if (typeof str !== "string") {
    return err(`Expected string, got ${typeof str}`);
  }
  try {
    return ok(JSON.parse(str));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// safeParseAs
// ---------------------------------------------------------------------------

/**
 * Type guard signature for safeParseAs.
 */
export type Validator<T> = (value: unknown) => value is T;

/**
 * Parse a JSON string and validate the result with a type guard.
 * Returns {ok: true, data: T} if both parse and validate succeed.
 * Returns {ok: false, error} if either step fails.
 */
export function safeParseAs<T>(str: string, validator: Validator<T>): Result<T> {
  const parsed = safeParse(str);
  if (!parsed.ok) return parsed;
  if (!validator(parsed.data)) {
    return err("Parsed value failed type guard validation");
  }
  return ok(parsed.data);
}

// ---------------------------------------------------------------------------
// safeStringify
// ---------------------------------------------------------------------------

/**
 * Stringify a value to JSON. Returns {ok: true, data: string} on success.
 * Handles circular references and BigInt values gracefully.
 */
export function safeStringify(val: unknown, indent?: number): Result<string> {
  try {
    const seen = new WeakSet();
    const str = JSON.stringify(
      val,
      (_key, value) => {
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) return "[Circular]";
          seen.add(value);
        }
        return value;
      },
      indent
    );
    if (str === undefined) {
      return err("Value serializes to undefined (functions, symbols, or undefined values)");
    }
    return ok(str);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// parseLenient
// ---------------------------------------------------------------------------

/**
 * Strip single-line comments, multi-line comments, and trailing commas from
 * a JSON-like string, then parse it. Useful for config files written as JSONC.
 * Returns {ok: true, data} on success, {ok: false, error} on failure.
 */
export function parseLenient(str: string): Result<unknown> {
  if (typeof str !== "string") {
    return err(`Expected string, got ${typeof str}`);
  }
  try {
    const cleaned = str
      // Remove single-line comments (// ...)
      .replace(/\/\/[^\n\r]*/g, "")
      // Remove multi-line comments (/* ... */)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Remove trailing commas before } or ]
      .replace(/,(\s*[}\]])/g, "$1");
    return safeParse(cleaned);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
