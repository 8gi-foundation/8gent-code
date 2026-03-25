/**
 * string-interpolate.ts
 *
 * Safe string interpolation with named variables and format pipes.
 * Supports nested property access, built-in formatters, and configurable
 * missing-variable handling.
 */

/** How to handle a variable that is not found in the context. */
export type MissingVarBehavior =
  | "throw"  // Throw a RangeError with the variable path
  | "blank"  // Replace with empty string
  | "keep";  // Leave the original placeholder untouched

export interface InterpolateOptions {
  /**
   * What to do when a variable is missing from context.
   * Default: "throw"
   */
  missing?: MissingVarBehavior;
}

/**
 * Resolve a dot-separated path against an object.
 * Returns `undefined` if any segment is missing.
 *
 * @example resolve("user.name", { user: { name: "Alice" } }) // "Alice"
 */
function resolve(path: string, ctx: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Apply a format pipe to a resolved value.
 *
 * Supported formatters:
 *   `iso`         - Date to ISO string  (Date or timestamp number)
 *   `fixed:N`     - Number to N decimal places
 *   `upper`       - String to UPPERCASE
 *   `lower`       - String to lowercase
 *   `trim`        - Trim whitespace
 *   `json`        - JSON.stringify
 *
 * Unknown formatters are silently ignored (value passes through).
 */
function applyFormatter(value: unknown, formatter: string): string {
  const [name, ...args] = formatter.split(":");

  switch (name) {
    case "iso": {
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "number") return new Date(value).toISOString();
      if (typeof value === "string") return new Date(value).toISOString();
      return String(value);
    }

    case "fixed": {
      const digits = args[0] !== undefined ? parseInt(args[0], 10) : 2;
      const n = typeof value === "number" ? value : parseFloat(String(value));
      if (isNaN(n)) return String(value);
      return n.toFixed(digits);
    }

    case "upper":
      return String(value).toUpperCase();

    case "lower":
      return String(value).toLowerCase();

    case "trim":
      return String(value).trim();

    case "json":
      return JSON.stringify(value);

    default:
      return String(value);
  }
}

/**
 * Interpolate a template string with named variable references.
 *
 * **Syntax:** `{varPath}` or `{varPath:formatter}` or `{varPath:formatter:arg}`
 *
 * @param template  Template string containing `{...}` placeholders
 * @param context   Object whose properties fill the placeholders
 * @param options   Behavior for missing variables (default: "throw")
 *
 * @example
 * interpolate("Hello {name}!", { name: "World" })
 * // -> "Hello World!"
 *
 * interpolate("Born: {dob:iso}", { dob: new Date("1990-01-01") })
 * // -> "Born: 1990-01-01T00:00:00.000Z"
 *
 * interpolate("Price: {amount:fixed:2}", { amount: 9.5 })
 * // -> "Price: 9.50"
 *
 * interpolate("Tag: {label:upper}", { label: "draft" })
 * // -> "Tag: DRAFT"
 *
 * interpolate("Hi {missing}", {}, { missing: "blank" })
 * // -> "Hi "
 *
 * interpolate("Hi {missing}", {}, { missing: "keep" })
 * // -> "Hi {missing}"
 */
export function interpolate(
  template: string,
  context: Record<string, unknown>,
  options: InterpolateOptions = {}
): string {
  const { missing = "throw" } = options;

  // Match {varPath} or {varPath:formatter} or {varPath:formatter:arg}
  return template.replace(/\{([^{}]+)\}/g, (placeholder, inner: string) => {
    // Split on first colon to separate path from formatter chain
    const colonIdx = inner.indexOf(":");
    const path = colonIdx === -1 ? inner : inner.slice(0, colonIdx);
    const formatterStr = colonIdx === -1 ? null : inner.slice(colonIdx + 1);

    const value = resolve(path.trim(), context);

    if (value === undefined) {
      switch (missing) {
        case "throw":
          throw new RangeError(
            `string-interpolate: variable "${path.trim()}" not found in context`
          );
        case "blank":
          return "";
        case "keep":
          return placeholder;
      }
    }

    if (formatterStr) {
      return applyFormatter(value, formatterStr);
    }

    return String(value);
  });
}
