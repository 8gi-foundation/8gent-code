/**
 * string-template-v2
 * Template strings with pipe filter syntax.
 *
 * Usage:
 *   template("Hello {name|upper}!", { name: "world" })
 *   // => "Hello WORLD!"
 *
 *   template("{bio|truncate:40|default:No bio}", { bio: "" })
 *   // => "No bio"
 */

// ---------------------------------------------------------------------------
// Filter registry
// ---------------------------------------------------------------------------

type FilterFn = (value: string, arg?: string) => string;

const filterRegistry = new Map<string, FilterFn>();

/** Register a custom filter by name. */
export function registerFilter(name: string, fn: FilterFn): void {
  filterRegistry.set(name, fn);
}

// ---------------------------------------------------------------------------
// Built-in filters
// ---------------------------------------------------------------------------

function applyBuiltin(value: string, name: string, arg?: string): string | null {
  switch (name) {
    case "upper":
      return value.toUpperCase();

    case "lower":
      return value.toLowerCase();

    case "trim":
      return value.trim();

    case "truncate": {
      const max = arg ? parseInt(arg, 10) : 80;
      if (isNaN(max) || max < 0) return value;
      return value.length > max ? value.slice(0, max) + "..." : value;
    }

    case "default":
      return value.trim() === "" ? (arg ?? "") : value;

    case "date": {
      // arg is a format string: "YYYY", "MM", "DD", "YYYY-MM-DD", "iso", "locale"
      const d = value ? new Date(value) : new Date();
      if (isNaN(d.getTime())) return value; // not a valid date — pass through
      const fmt = arg ?? "iso";
      if (fmt === "iso") return d.toISOString();
      if (fmt === "locale") return d.toLocaleDateString();
      return fmt
        .replace("YYYY", String(d.getUTCFullYear()))
        .replace("MM", String(d.getUTCMonth() + 1).padStart(2, "0"))
        .replace("DD", String(d.getUTCDate()).padStart(2, "0"));
    }

    default:
      return null; // not a builtin - caller will check registry
  }
}

// ---------------------------------------------------------------------------
// Filter application pipeline
// ---------------------------------------------------------------------------

function applyFilters(raw: string, filters: string[]): string {
  let value = raw;

  for (const token of filters) {
    const colonIdx = token.indexOf(":");
    const name = colonIdx === -1 ? token : token.slice(0, colonIdx);
    const arg = colonIdx === -1 ? undefined : token.slice(colonIdx + 1);

    const builtin = applyBuiltin(value, name, arg);
    if (builtin !== null) {
      value = builtin;
      continue;
    }

    const custom = filterRegistry.get(name);
    if (custom) {
      value = custom(value, arg);
      continue;
    }

    // Unknown filter - warn in non-production, otherwise pass through silently
    if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
      process.stderr.write(`[string-template-v2] Unknown filter: "${name}"\n`);
    }
  }

  return value;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TemplateOptions {
  /** String used when a key is missing from data. Default: "" */
  missing?: string;
  /** Opening delimiter. Default: "{" */
  open?: string;
  /** Closing delimiter. Default: "}" */
  close?: string;
}

// ---------------------------------------------------------------------------
// Main template function
// ---------------------------------------------------------------------------

/**
 * Render a template string, resolving `{key|filter1|filter2}` expressions.
 *
 * @param str    Template string, e.g. "Hello {name|upper}!"
 * @param data   Key-value map of variables
 * @param opts   Optional delimiter and missing-key overrides
 */
export function template(
  str: string,
  data: Record<string, unknown>,
  opts: TemplateOptions = {}
): string {
  const open = escapeRegExp(opts.open ?? "{");
  const close = escapeRegExp(opts.close ?? "}");
  const missing = opts.missing ?? "";

  const pattern = new RegExp(`${open}([^${opts.close ?? "}"}]+)${close}`, "g");

  return str.replace(pattern, (_match, expr: string) => {
    const parts = expr.split("|").map((s) => s.trim());
    const key = parts[0];
    const filters = parts.slice(1);

    const raw =
      key in data && data[key] !== null && data[key] !== undefined
        ? String(data[key])
        : missing;

    return filters.length > 0 ? applyFilters(raw, filters) : raw;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
