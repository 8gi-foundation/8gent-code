/**
 * command-line-args.ts
 * Parses CLI arguments into typed options with aliases, defaults,
 * required fields, boolean flags, positionals, and help generation.
 */

export type ArgType = "string" | "number" | "boolean";

export interface ArgDef {
  type: ArgType;
  alias?: string;
  default?: string | number | boolean;
  required?: boolean;
  description?: string;
}

export interface ArgSchema {
  [key: string]: ArgDef;
}

export interface ParseResult {
  options: Record<string, string | number | boolean>;
  positionals: string[];
  errors: string[];
}

function coerce(value: string, type: ArgType): string | number | boolean {
  if (type === "boolean") return value === "true" || value === "1";
  if (type === "number") {
    const n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  return value;
}

function resolveKey(raw: string, schema: ArgSchema): string | null {
  // raw is the flag name without leading dashes
  if (schema[raw]) return raw;
  for (const [key, def] of Object.entries(schema)) {
    if (def.alias === raw) return key;
  }
  return null;
}

/**
 * Parse process.argv-style array into typed options.
 *
 * Supports:
 *   --flag          boolean true
 *   --flag=value    inline value
 *   --flag value    next-token value
 *   -f / -f value   alias forms
 *   --no-flag       boolean false
 *   bare tokens     collected as positionals
 */
export function parseArgs(argv: string[], schema: ArgSchema): ParseResult {
  const options: Record<string, string | number | boolean> = {};
  const positionals: string[] = [];
  const errors: string[] = [];

  // Apply defaults first
  for (const [key, def] of Object.entries(schema)) {
    if (def.default !== undefined) {
      options[key] = def.default;
    } else if (def.type === "boolean") {
      options[key] = false;
    }
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];

    if (token === "--") {
      // Everything after -- is positional
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const raw = token.slice(2);

      // --no-flag form
      if (raw.startsWith("no-")) {
        const flagName = raw.slice(3);
        const key = resolveKey(flagName, schema);
        if (key && schema[key].type === "boolean") {
          options[key] = false;
          i++;
          continue;
        }
      }

      // --flag=value or --flag
      const eqIdx = raw.indexOf("=");
      if (eqIdx !== -1) {
        const flagName = raw.slice(0, eqIdx);
        const value = raw.slice(eqIdx + 1);
        const key = resolveKey(flagName, schema);
        if (key) {
          options[key] = coerce(value, schema[key].type);
        } else {
          errors.push(`Unknown option: --${flagName}`);
        }
        i++;
        continue;
      }

      const key = resolveKey(raw, schema);
      if (!key) {
        errors.push(`Unknown option: --${raw}`);
        i++;
        continue;
      }

      const def = schema[key];
      if (def.type === "boolean") {
        options[key] = true;
        i++;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          options[key] = coerce(next, def.type);
          i += 2;
        } else {
          errors.push(`Option --${raw} requires a value`);
          i++;
        }
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const alias = token.slice(1);
      const key = resolveKey(alias, schema);
      if (!key) {
        errors.push(`Unknown option: -${alias}`);
        i++;
        continue;
      }
      const def = schema[key];
      if (def.type === "boolean") {
        options[key] = true;
        i++;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          options[key] = coerce(next, def.type);
          i += 2;
        } else {
          errors.push(`Option -${alias} requires a value`);
          i++;
        }
      }
      continue;
    }

    positionals.push(token);
    i++;
  }

  // Validate required fields
  for (const [key, def] of Object.entries(schema)) {
    if (def.required && options[key] === undefined) {
      errors.push(`Required option missing: --${key}`);
    }
  }

  return { options, positionals, errors };
}

/**
 * Generate a usage help string from the schema.
 */
export function generateHelp(schema: ArgSchema, programName = "program"): string {
  const lines: string[] = [`Usage: ${programName} [options] [args...]`, "", "Options:"];

  for (const [key, def] of Object.entries(schema)) {
    const flag = def.alias ? `-${def.alias}, --${key}` : `    --${key}`;
    const typeLabel = def.type !== "boolean" ? ` <${def.type}>` : "";
    const defaultLabel = def.default !== undefined ? ` (default: ${def.default})` : "";
    const requiredLabel = def.required ? " [required]" : "";
    const desc = def.description ?? "";
    lines.push(`  ${flag}${typeLabel}  ${desc}${defaultLabel}${requiredLabel}`);
  }

  return lines.join("\n");
}
