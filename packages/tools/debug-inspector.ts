/**
 * debug-inspector - runtime value inspector with pretty-printed type information
 * Self-contained, no external dependencies.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

const MAX_STRING_LENGTH = 80;
const MAX_ARRAY_ITEMS = 10;
const MAX_OBJECT_KEYS = 12;

function colorize(text: string, color: keyof typeof ANSI): string {
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** Returns a detailed type string for a value */
export function inspectType(value: unknown): string {
  if (value === null) return colorize("null", "magenta");
  if (value === undefined) return colorize("undefined", "gray");

  const t = typeof value;

  if (t === "boolean") return colorize(`boolean(${value})`, "yellow");
  if (t === "number") {
    if (Number.isNaN(value as number)) return colorize("NaN", "red");
    if (!Number.isFinite(value as number)) return colorize("Infinity", "red");
    if (Number.isInteger(value as number)) return colorize(`int(${value})`, "cyan");
    return colorize(`float(${(value as number).toFixed(4)})`, "cyan");
  }
  if (t === "string") {
    const s = value as string;
    return colorize(`string[${s.length}]`, "green") + ` "${truncate(s, MAX_STRING_LENGTH)}"`;
  }
  if (t === "bigint") return colorize(`bigint(${value}n)`, "cyan");
  if (t === "symbol") return colorize(`symbol(${(value as symbol).toString()})`, "magenta");
  if (t === "function") {
    const fn = value as Function;
    return colorize(`function ${fn.name || "<anonymous>"}(${fn.length} args)`, "blue");
  }
  if (Array.isArray(value)) {
    return colorize(`Array[${value.length}]`, "yellow");
  }
  if (value instanceof Date) return colorize(`Date(${value.toISOString()})`, "magenta");
  if (value instanceof RegExp) return colorize(`RegExp(${value.toString()})`, "magenta");
  if (value instanceof Error) return colorize(`Error(${(value as Error).message})`, "red");
  if (value instanceof Map) return colorize(`Map[${(value as Map<unknown, unknown>).size}]`, "blue");
  if (value instanceof Set) return colorize(`Set[${(value as Set<unknown>).size}]`, "blue");
  if (t === "object") {
    const keys = Object.keys(value as object).length;
    const name = (value as object).constructor?.name ?? "Object";
    return colorize(`${name}{${keys} keys}`, "cyan");
  }
  return colorize(t, "gray");
}

/** Pretty-prints a value with types, depth control, ANSI colors */
export function inspect(value: unknown, depth = 2, _indent = 0): string {
  const pad = "  ".repeat(_indent);
  const childPad = "  ".repeat(_indent + 1);

  if (value === null) return colorize("null", "magenta");
  if (value === undefined) return colorize("undefined", "gray");

  const t = typeof value;

  if (t === "boolean") return colorize(String(value), "yellow");
  if (t === "number") {
    if (Number.isNaN(value as number)) return colorize("NaN", "red");
    return colorize(String(value), "cyan");
  }
  if (t === "string") {
    const s = truncate(value as string, MAX_STRING_LENGTH);
    return colorize(`"${s}"`, "green");
  }
  if (t === "bigint") return colorize(`${value}n`, "cyan");
  if (t === "symbol") return colorize((value as symbol).toString(), "magenta");
  if (t === "function") {
    const fn = value as Function;
    return colorize(`[Function: ${fn.name || "<anonymous>"}]`, "blue");
  }

  if (_indent >= depth) {
    return colorize(`[${inspectType(value)}]`, "dim" as keyof typeof ANSI);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return colorize("[]", "yellow");
    const items = value.slice(0, MAX_ARRAY_ITEMS).map(
      (item) => `${childPad}${inspect(item, depth, _indent + 1)}`
    );
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`${childPad}${colorize(`... ${value.length - MAX_ARRAY_ITEMS} more`, "gray")}`);
    }
    return `${colorize("[", "yellow")}\n${items.join(",\n")}\n${pad}${colorize("]", "yellow")}`;
  }

  if (value instanceof Map) {
    const m = value as Map<unknown, unknown>;
    const entries = [...m.entries()].slice(0, MAX_OBJECT_KEYS).map(
      ([k, v]) => `${childPad}${inspect(k, depth, _indent + 1)} => ${inspect(v, depth, _indent + 1)}`
    );
    return `${colorize("Map {", "blue")}\n${entries.join(",\n")}\n${pad}${colorize("}", "blue")}`;
  }

  if (value instanceof Set) {
    const s = value as Set<unknown>;
    const items = [...s].slice(0, MAX_ARRAY_ITEMS).map(
      (item) => `${childPad}${inspect(item, depth, _indent + 1)}`
    );
    return `${colorize("Set {", "blue")}\n${items.join(",\n")}\n${pad}${colorize("}", "blue")}`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return colorize("{}", "cyan");
    const shown = keys.slice(0, MAX_OBJECT_KEYS);
    const lines = shown.map(
      (k) => `${childPad}${colorize(k, "cyan")}: ${inspect(obj[k], depth, _indent + 1)}`
    );
    if (keys.length > MAX_OBJECT_KEYS) {
      lines.push(`${childPad}${colorize(`... ${keys.length - MAX_OBJECT_KEYS} more`, "gray")}`);
    }
    return `${colorize("{", "cyan")}\n${lines.join(",\n")}\n${pad}${colorize("}", "cyan")}`;
  }

  return String(value);
}

/** Highlights differences between two values. Returns a diff summary string. */
export function inspectDiff(a: unknown, b: unknown, _path = ""): string {
  if (a === b) return colorize(`(identical) ${_path || "root"}`, "green");

  const lines: string[] = [];

  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
    lines.push(
      `${colorize(_path || "root", "bold" as keyof typeof ANSI)}: type changed ` +
      `${colorize(inspectType(a), "red")} -> ${colorize(inspectType(b), "green")}`
    );
    return lines.join("\n");
  }

  if (
    typeof a === "object" && a !== null && b !== null &&
    !Array.isArray(a) && !(a instanceof Date) && !(a instanceof RegExp)
  ) {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

    for (const key of allKeys) {
      const childPath = _path ? `${_path}.${key}` : key;
      if (!(key in aObj)) {
        lines.push(`${colorize("+ " + childPath, "green")}: ${inspect(bObj[key], 1)}`);
      } else if (!(key in bObj)) {
        lines.push(`${colorize("- " + childPath, "red")}: ${inspect(aObj[key], 1)}`);
      } else if (aObj[key] !== bObj[key]) {
        lines.push(
          `${colorize("~ " + childPath, "yellow")}: ` +
          `${inspect(aObj[key], 1)} -> ${inspect(bObj[key], 1)}`
        );
      }
    }
    return lines.length ? lines.join("\n") : colorize("(no differences)", "green");
  }

  lines.push(
    `${colorize(_path || "root", "yellow")}: ${inspect(a, 1)} -> ${inspect(b, 1)}`
  );
  return lines.join("\n");
}
