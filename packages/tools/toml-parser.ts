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
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitArray(inner).map(parseValue);
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    return parseInlineTable(s.slice(1, -1).trim());
  }
  if (s.startsWith('"""') && s.endsWith('"""')) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
  }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }
  if (/^[-+]?\d+\.\d+([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
  if (/^0x[\da-fA-F_]+$/.test(s)) return parseInt(s.replace(/_/g, ""), 16);
  if (/^0o[0-7_]+$/.test(s)) return parseInt(s.replace(/0o|_/g, ""), 8);
  if (/^0b[01_]+$/.test(s)) return parseInt(s.replace(/0b|_/g, ""), 2);
  if (/^[-+]?\d[\d_]*$/.test(s)) return parseInt(s.replace(/_/g, ""), 10);
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
      inStr = true; strChar = ch; current += ch;
    } else if (ch === "[" || ch === "{") {
      depth++; current += ch;
    } else if (ch === "]" || ch === "}") {
      depth--; current += ch;
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
  for (const pair of splitArray(input)) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim().replace(/^["']|["']$/g, "");
    result[key] = parseValue(pair.slice(eqIdx + 1).trim());
  }
  return result;
}

function setNestedKey(obj: Record<string, TOMLValue>, keys: string[], value: TOMLValue): void {
  let cur = obj;
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

  for (const raw of input.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd().trim();
    if (!line) continue;

    // Array of tables [[key]]
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const keys = line.slice(2, -2).trim().split(".");
      let parent = root;
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
      continue;
    }

    // Table [key]
    if (line.startsWith("[") && line.endsWith("]")) {
      const keys = line.slice(1, -1).trim().split(".");
      let target = root;
      for (const k of keys) {
        if (!(k in target)) target[k] = {} as Record<string, TOMLValue>;
        target = target[k] as Record<string, TOMLValue>;
      }
      current = target;
      continue;
    }

    // Key-value
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const keys = line.slice(0, eqIdx).trim().replace(/^["']|["']$/g, "").split(".").map((k) => k.trim());
    setNestedKey(current, keys, parseValue(line.slice(eqIdx + 1).trim()));
  }

  return root;
}
