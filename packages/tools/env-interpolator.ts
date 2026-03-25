/**
 * env-interpolator.ts
 *
 * Interpolates ${VAR} and ${VAR:-default} references in config strings
 * using the provided env map or process.env. Supports nested references
 * and reports missing variables without defaults.
 */

export interface InterpolateOptions {
  /** Throw on missing vars (default: false - collect errors instead) */
  strict?: boolean;
  /** Max recursion depth for nested refs (default: 10) */
  maxDepth?: number;
}

export interface InterpolateResult {
  value: string;
  missing: string[];
  resolved: Record<string, string>;
}

const VAR_PATTERN = /\$\{([^}]+)\}/g;
const DEFAULT_MAX_DEPTH = 10;

function parseExpr(expr: string): { name: string; defaultValue: string | undefined } {
  const colonDashIdx = expr.indexOf(":-");
  if (colonDashIdx !== -1) {
    return {
      name: expr.slice(0, colonDashIdx),
      defaultValue: expr.slice(colonDashIdx + 2),
    };
  }
  return { name: expr, defaultValue: undefined };
}

function lookup(name: string, env: Record<string, string | undefined>): string | undefined {
  return env[name];
}

function interpolatePass(
  template: string,
  env: Record<string, string | undefined>,
  missing: Set<string>,
  resolved: Record<string, string>
): string {
  return template.replace(VAR_PATTERN, (match, expr: string) => {
    const { name, defaultValue } = parseExpr(expr.trim());
    const val = lookup(name, env);

    if (val !== undefined) {
      resolved[name] = val;
      return val;
    }

    if (defaultValue !== undefined) {
      return defaultValue;
    }

    missing.add(name);
    return match;
  });
}

/**
 * Interpolate ${VAR} and ${VAR:-default} references in a template string.
 *
 * @param template - The string containing ${...} references
 * @param env - Optional env override map (falls back to process.env)
 * @param options - Behaviour options
 * @returns InterpolateResult with final value, list of missing vars, and resolved map
 */
export function interpolate(
  template: string,
  env?: Record<string, string | undefined>,
  options: InterpolateOptions = {}
): InterpolateResult {
  const { strict = false, maxDepth = DEFAULT_MAX_DEPTH } = options;
  const envMap: Record<string, string | undefined> = env ?? (process.env as Record<string, string | undefined>);
  const missing = new Set<string>();
  const resolved: Record<string, string> = {};

  let current = template;
  let depth = 0;

  while (depth < maxDepth) {
    missing.clear();
    const next = interpolatePass(current, envMap, missing, resolved);
    if (next === current) break;
    current = next;
    depth++;
    if (!VAR_PATTERN.test(current)) break;
    VAR_PATTERN.lastIndex = 0;
  }

  const finalMissing = new Set<string>();
  current.replace(VAR_PATTERN, (_match, expr: string) => {
    const { name } = parseExpr(expr.trim());
    finalMissing.add(name);
    return _match;
  });
  VAR_PATTERN.lastIndex = 0;

  if (strict && finalMissing.size > 0) {
    throw new Error(
      `env-interpolator: missing variables with no default: ${[...finalMissing].join(", ")}`
    );
  }

  return {
    value: current,
    missing: [...finalMissing],
    resolved,
  };
}

/**
 * Interpolate all string values in a plain config object.
 * Returns a new object with all string leaves interpolated.
 */
export function interpolateConfig<T extends Record<string, unknown>>(
  config: T,
  env?: Record<string, string | undefined>,
  options: InterpolateOptions = {}
): { config: T; missing: string[] } {
  const allMissing: string[] = [];

  function walk(obj: unknown): unknown {
    if (typeof obj === "string") {
      const result = interpolate(obj, env, options);
      allMissing.push(...result.missing);
      return result.value;
    }
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj !== null && typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = walk(v);
      }
      return out;
    }
    return obj;
  }

  return {
    config: walk(config) as T,
    missing: [...new Set(allMissing)],
  };
}
