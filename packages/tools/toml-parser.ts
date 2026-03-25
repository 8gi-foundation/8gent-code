/**
 * Lightweight zero-dependency TOML config parser.
 * Supports: tables, arrays, inline tables, strings, numbers, booleans, dates.
 * Export: parseTOML(input: string) => Record<string, unknown>
 */

type TOMLValue =
  | string
  | number
  | boolean
  | Date
  | TOMLValue[]
  | Record<string, TOMLValue>;

function parseValue(raw: string): TOMLValue {
  const s = raw.trim();

  // Boolean
  if (s === "true") return true;
  if (s === "false") return false;

  // Inline array
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitArray(inner).map(parseValue);
  }

  // Inline table
  if (s.startsWith("{") && s.endsWith("}")) {
    return parseInlineTable(s.slice(1, -1).trim());
  }

  // Triple-quoted strings
  if (s.startsWith('"""') && s.endsWith('"""')) {
    return s.slice(3, -3);
  }
  if (s.startsWith("'''") && s.endsWith("'''")) {
    return s.slice(3, -3);
  }

  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
  }

  // Date/datetime (ISO 8601 subset)
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }

  // Float
  if (/^[-+]?\d+\.\d+([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);

  // Integer (hex, octal, binary, decimal)
  if (/^0x[\da-fA-F_]+$/.test(s)) return parseInt(s.replace(/_/g, ""), 16);
  if (/^0o[0-7_]+$/.test(s)) return parseInt(s.replace(/0o|_/g, ""), 8);
  if (/^0b[01_]+$/.test(s)) return parseInt(s.replace(/0b|_/g, ""), 2);
  if (/^[-+]?\d[\d_]*$/.test(s)) return parseInt(s.replace(/_/g, ""), 10);

  // Fallback: bare string (unquoted)
  return s;
}

function splitArray(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let strChar = "";
  let current = "";

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inStr) {
      current += ch;
      if (ch === strChar && input[i - 1] !== "\\") inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseInlineTable(input: string): Record<string, TOMLValue> {
  const result: Record<string, TOMLValue> = {};
  const pairs = splitArray(input);
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim().replace(/^["']|["']$/g, "");
    const val = pair.slice(eqIdx + 1).trim();
    result[key] = parseValue(val);
  }
  return result;
}

function setNestedKey(
  obj: Record<string, TOMLValue>,
  keys: string[],
  value: TOMLValue
): void {
  let cur = obj as Record<string, TOMLValue>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!(k in cur)) cur[k] = {} as Record<string, TOMLValue>;
    cur = cur[k] as Record<string, TOMLValue>;
  }
  cur[keys[keys.length - 1]] = value;
}

export function parseTOML(input: string): Record<string, TOMLValue> {
  const root: Record<string, TOMLValue> = {};
  let current: Record<string, TOMLValue> = root;
  let currentArray: TOMLValue[] | null = null;

  const lines = input.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, "").trimEnd();
    const trimmed = line.trim();

    if (!trimmed) continue;

    // Array of tables [[key]]
    if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
      const key = trimmed.slice(2, -2).trim();
      const keys = key.split(".");
      let parent = root as Record<string, TOMLValue>;
      for (let j = 0; j < keys.length - 1; j++) {
        const k = keys[j];
        if (!(k in parent)) parent[k] = {} as Record<string, TOMLValue>;
        parent = parent[k] as Record<string, TOMLValue>;
      }
      const last = keys[keys.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      const entry: Record<string, TOMLValue> = {};
      (parent[last] as TOMLValue[]).push(entry);
      current = entry;
      currentArray = parent[last] as TOMLValue[];
      continue;
    }

    // Table [key]
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const key = trimmed.slice(1, -1).trim();
      const keys = key.split(".");
      let target = root as Record<string, TOMLValue>;
      for (const k of keys) {
        if (!(k in target)) target[k] = {} as Record<string, TOMLValue>;
        target = target[k] as Record<string, TOMLValue>;
      }
      current = target;
      currentArray = null;
      continue;
    }

    // Key-value pair
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const rawKey = trimmed.slice(0, eqIdx).trim().replace(/^["']|["']$/g, "");
    const rawVal = trimmed.slice(eqIdx + 1).trim();
    const keys = rawKey.split(".").map((k) => k.trim());

    setNestedKey(current, keys, parseValue(rawVal));
  }

  return root;
}
