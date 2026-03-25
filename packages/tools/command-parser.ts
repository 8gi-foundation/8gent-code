/**
 * command-parser.ts
 * Parses CLI-style command strings into structured arguments and flags.
 * No external dependencies. Self-contained.
 */

export interface ParsedCommand {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  raw: string;
}

export interface FlagSchema {
  [longName: string]: {
    short?: string;       // e.g. "f" for --file -> -f
    type?: "string" | "boolean";
    default?: string | boolean;
  };
}

/** Tokenize a raw CLI string, respecting quoted segments. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Build a reverse map from short aliases to long name using the schema.
 */
function buildShortMap(schema: FlagSchema): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [long, def] of Object.entries(schema)) {
    if (def.short) {
      map[def.short] = long;
    }
  }
  return map;
}

/**
 * Parse a CLI-style command string into structured parts.
 *
 * @param input  Raw string, e.g. `deploy --env prod -v --dry-run "my app"`
 * @param schema Optional flag schema defining types and short aliases.
 *
 * @example
 * parseCommand('push --tag v1.0 --verbose -m "initial commit"')
 * // => {
 * //   command: "push",
 * //   positional: [],
 * //   flags: { tag: "v1.0", verbose: true, m: "initial commit" },
 * //   raw: 'push --tag v1.0 ...'
 * // }
 */
export function parseCommand(input: string, schema: FlagSchema = {}): ParsedCommand {
  const trimmed = input.trim();
  const tokens = tokenize(trimmed);
  const shortMap = buildShortMap(schema);

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  // Seed defaults from schema
  for (const [name, def] of Object.entries(schema)) {
    if (def.default !== undefined) {
      flags[name] = def.default;
    }
  }

  const command = tokens[0] ?? "";

  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.startsWith("--")) {
      const key = token.slice(2);

      if (key.includes("=")) {
        const eqIdx = key.indexOf("=");
        const flagName = key.slice(0, eqIdx);
        const flagVal = key.slice(eqIdx + 1);
        flags[flagName] = flagVal;
        i++;
        continue;
      }

      const schemaDef = schema[key];
      const isBoolean =
        schemaDef?.type === "boolean" ||
        (!schemaDef &&
          (tokens[i + 1] === undefined || tokens[i + 1].startsWith("-")));

      if (!isBoolean && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        flags[key] = tokens[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (token.startsWith("-") && token.length === 2) {
      const short = token.slice(1);
      const resolvedKey = shortMap[short] ?? short;
      const schemaDef = schema[resolvedKey];
      const isBoolean =
        schemaDef?.type === "boolean" ||
        (!schemaDef &&
          (tokens[i + 1] === undefined || tokens[i + 1].startsWith("-")));

      if (!isBoolean && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        flags[resolvedKey] = tokens[i + 1];
        i += 2;
      } else {
        flags[resolvedKey] = true;
        i++;
      }
    } else if (token.startsWith("-") && token.length > 2) {
      // Stacked boolean flags: -abc => a=true, b=true, c=true
      const chars = token.slice(1).split("");
      for (const ch of chars) {
        const resolvedKey = shortMap[ch] ?? ch;
        flags[resolvedKey] = true;
      }
      i++;
    } else {
      positional.push(token);
      i++;
    }
  }

  return { command, positional, flags, raw: trimmed };
}
