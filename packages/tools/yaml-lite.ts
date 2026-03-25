/**
 * yaml-lite.ts
 * Zero-dependency YAML parser and stringifier.
 * Supports: key-value pairs, nested objects, arrays, comments, multiline strings.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface ParseContext {
  lines: string[];
  pos: number;
}

function getIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}
function isComment(line: string): boolean {
  return line.trimStart().startsWith("#");
}
function isBlank(line: string): boolean {
  return line.trim() === "";
}
function skipBlankAndComments(ctx: ParseContext): void {
  while (ctx.pos < ctx.lines.length && (isBlank(ctx.lines[ctx.pos]) || isComment(ctx.lines[ctx.pos]))) {
    ctx.pos++;
  }
}

function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === "") return s;
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\").replace(/\\"/g, '"');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (s === ".inf" || s === ".Inf" || s === ".INF") return Infinity;
  if (s === "-.inf" || s === "-.Inf" || s === "-.INF") return -Infinity;
  if (s === ".nan" || s === ".NaN" || s === ".NAN") return NaN;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^-?(?:0|[1-9][0-9]*)$/.test(s)) return parseInt(s, 10);
  if (/^-?(?:[0-9]+\.[0-9]*|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(s)) return parseFloat(s);
  return s;
}

function parseBlockScalar(ctx: ParseContext, style: "|" | ">", baseIndent: number): string {
  let blockIndent = -1;
  const collected: string[] = [];
  while (ctx.pos < ctx.lines.length) {
    const line = ctx.lines[ctx.pos];
    if (!isBlank(line)) {
      const ind = getIndent(line);
      if (ind <= baseIndent) break;
      if (blockIndent === -1) blockIndent = ind;
      if (ind < blockIndent) break;
    }
    collected.push(ctx.lines[ctx.pos]);
    ctx.pos++;
  }
  if (blockIndent === -1) return "";
  const stripped = collected.map((l) => (isBlank(l) ? "" : l.slice(blockIndent)));
  if (style === "|") {
    return stripped.join("\n").replace(/\n+$/, "") + "\n";
  } else {
    let out = "";
    let prevBlank = false;
    for (let i = 0; i < stripped.length; i++) {
      const cur = stripped[i];
      if (cur === "") { out += "\n"; prevBlank = true; }
      else { if (i > 0 && !prevBlank) out += " "; out += cur; prevBlank = false; }
    }
    return out.trimEnd() + "\n";
  }
}

function findMappingColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ":" && !inSingle && !inDouble) {
      if (i + 1 >= s.length || s[i + 1] === " " || s[i + 1] === "\t") return i;
    }
  }
  return -1;
}

function splitInlineItems(s: string): string[] {
  const items: string[] = [];
  let depth = 0, inSingle = false, inDouble = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) { items.push(s.slice(start, i)); start = i + 1; }
    }
  }
  items.push(s.slice(start));
  return items;
}

function parseInlineArray(s: string): YamlValue[] {
  const inner = s.trim();
  const last = inner.lastIndexOf("]");
  const content = inner.startsWith("[") && last !== -1 ? inner.slice(1, last) : inner;
  if (content.trim() === "") return [];
  return splitInlineItems(content).map((item) => parseScalar(item.trim()));
}

function parseInlineMapping(s: string): { [key: string]: YamlValue } {
  const inner = s.trim();
  const last = inner.lastIndexOf("}");
  const content = inner.startsWith("{") && last !== -1 ? inner.slice(1, last) : inner;
  if (content.trim() === "") return {};
  const obj: { [key: string]: YamlValue } = {};
  splitInlineItems(content).forEach((pair) => {
    const ci = findMappingColon(pair.trim());
    if (ci === -1) return;
    obj[pair.trim().slice(0, ci).trim()] = parseScalar(pair.trim().slice(ci + 1).trim());
  });
  return obj;
}

function parseValue(ctx: ParseContext, indent: number): YamlValue;

function parseBlockSequence(ctx: ParseContext, baseIndent: number): YamlValue[] {
  const arr: YamlValue[] = [];
  while (ctx.pos < ctx.lines.length) {
    skipBlankAndComments(ctx);
    if (ctx.pos >= ctx.lines.length) break;
    const line = ctx.lines[ctx.pos];
    const lineIndent = getIndent(line);
    const trimmed = line.trimStart();
    if (lineIndent !== baseIndent) break;
    if (!trimmed.startsWith("-")) break;
    ctx.pos++;
    const after = trimmed.slice(1).trimStart();
    if (after === "|" || after === ">") {
      arr.push(parseBlockScalar(ctx, after as "|" | ">", lineIndent));
    } else if (after === "") {
      skipBlankAndComments(ctx);
      if (ctx.pos < ctx.lines.length && getIndent(ctx.lines[ctx.pos]) > baseIndent) {
        arr.push(parseValue(ctx, getIndent(ctx.lines[ctx.pos])));
      } else arr.push(null);
    } else if (after.startsWith("[")) {
      arr.push(parseInlineArray(after));
    } else if (after.startsWith("{")) {
      arr.push(parseInlineMapping(after));
    } else {
      const ci = findMappingColon(after);
      if (ci !== -1) {
        const synLines: string[] = [" ".repeat(baseIndent + 2) + after];
        while (ctx.pos < ctx.lines.length) {
          const nl = ctx.lines[ctx.pos];
          if (isBlank(nl) || isComment(nl)) { ctx.pos++; continue; }
          if (getIndent(nl) > baseIndent) { synLines.push(nl); ctx.pos++; }
          else break;
        }
        arr.push(parseBlockMapping({ lines: synLines, pos: 0 }, baseIndent + 2));
      } else arr.push(parseScalar(after));
    }
  }
  return arr;
}

function parseBlockMapping(ctx: ParseContext, baseIndent: number): { [key: string]: YamlValue } {
  const obj: { [key: string]: YamlValue } = {};
  while (ctx.pos < ctx.lines.length) {
    skipBlankAndComments(ctx);
    if (ctx.pos >= ctx.lines.length) break;
    const line = ctx.lines[ctx.pos];
    const lineIndent = getIndent(line);
    const trimmed = line.trimStart();
    if (lineIndent < baseIndent || lineIndent > baseIndent) break;
    const ci = findMappingColon(trimmed);
    if (ci === -1) break;
    const key = trimmed.slice(0, ci).trim();
    const rest = trimmed.slice(ci + 1).trimStart();
    ctx.pos++;
    if (rest === "|" || rest === ">") {
      obj[key] = parseBlockScalar(ctx, rest as "|" | ">", lineIndent);
    } else if (rest === "") {
      skipBlankAndComments(ctx);
      if (ctx.pos < ctx.lines.length && getIndent(ctx.lines[ctx.pos]) > baseIndent) {
        obj[key] = parseValue(ctx, getIndent(ctx.lines[ctx.pos]));
      } else obj[key] = null;
    } else if (rest.startsWith("[")) { obj[key] = parseInlineArray(rest); }
    else if (rest.startsWith("{")) { obj[key] = parseInlineMapping(rest); }
    else obj[key] = parseScalar(rest);
  }
  return obj;
}

function parseValue(ctx: ParseContext, indent: number): YamlValue {
  skipBlankAndComments(ctx);
  if (ctx.pos >= ctx.lines.length) return null;
  const line = ctx.lines[ctx.pos];
  const trimmed = line.trimStart();
  if (trimmed.startsWith("[")) { ctx.pos++; return parseInlineArray(trimmed); }
  if (trimmed.startsWith("{")) { ctx.pos++; return parseInlineMapping(trimmed); }
  if (trimmed.startsWith("- ") || trimmed === "-") return parseBlockSequence(ctx, getIndent(line));
  if (/^\S.*:/.test(trimmed)) return parseBlockMapping(ctx, getIndent(line));
  ctx.pos++;
  return parseScalar(trimmed);
}

/**
 * Parse a YAML string into a JavaScript value.
 * Supports: key-value pairs, nested objects, block sequences, inline arrays/mappings,
 * literal block scalars (|), folded block scalars (>), comments, all scalar types.
 * Document markers (---/...) are stripped silently.
 */
export function parseYaml(input: string): YamlValue {
  if (typeof input !== "string") throw new TypeError("parseYaml: input must be a string");
  const lines = input.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("..."));
  const ctx: ParseContext = { lines, pos: 0 };
  skipBlankAndComments(ctx);
  if (ctx.pos >= ctx.lines.length) return null;
  const ft = ctx.lines[ctx.pos].trimStart();
  if (ft.startsWith("- ") || ft === "-") return parseBlockSequence(ctx, getIndent(ctx.lines[ctx.pos]));
  if (/^\S.*:/.test(ft)) return parseBlockMapping(ctx, getIndent(ctx.lines[ctx.pos]));
  if (ft.startsWith("[")) { ctx.pos++; return parseInlineArray(ft); }
  if (ft.startsWith("{")) { ctx.pos++; return parseInlineMapping(ft); }
  ctx.pos++;
  return parseScalar(ft);
}

// ---------------------------------------------------------------------------
// Stringify
// ---------------------------------------------------------------------------

const SPECIAL_CHARS = /[:{}[\],#&*!|>'"@`\n\r\\]/;

function shouldQuote(s: string): boolean {
  if (s === "") return true;
  if (SPECIAL_CHARS.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/^[-?](\s|$)/.test(s)) return true;
  if (/^-?(?:0|[1-9][0-9]*)$/.test(s)) return true;
  if (/^-?(?:[0-9]+\.[0-9]*|[0-9]*\.[0-9]+)/.test(s)) return true;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return true;
  if (/^0o[0-7]+$/.test(s)) return true;
  if (/^(true|false|null|~|\.inf|-.inf|\.nan)$/i.test(s)) return true;
  return false;
}

function quoteStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"';
}

function stringifyValue(value: YamlValue, indent: number, inlineDepth: number): string {
  const pad = " ".repeat(indent);
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ".nan";
    if (!isFinite(value)) return value > 0 ? ".inf" : "-.inf";
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\n")) {
      const ls = value.split("\n");
      if (ls[ls.length - 1] === "") ls.pop();
      return "|\n" + ls.map((l) => pad + "  " + l).join("\n") + "\n";
    }
    return shouldQuote(value) ? quoteStr(value) : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const allScalar = value.every((v) => v === null || typeof v !== "object");
    if (inlineDepth > 0 && allScalar) {
      return "[" + value.map((v) => stringifyValue(v, 0, inlineDepth + 1)).join(", ") + "]";
    }
    return value.map((item) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item as { [k: string]: YamlValue });
        if (entries.length === 0) return pad + "- {}";
        const [fk, fv] = entries[0];
        const fl = pad + "- " + (shouldQuote(fk) ? quoteStr(fk) : fk) + ": " +
          (fv !== null && typeof fv === "object" ? "\n" + stringifyValue(fv, indent + 4, 0) : stringifyValue(fv, indent + 2, 0));
        const rest = entries.slice(1).map(([k, v]) =>
          pad + "  " + (shouldQuote(k) ? quoteStr(k) : k) + ": " +
          (v !== null && typeof v === "object" ? "\n" + stringifyValue(v, indent + 4, 0) : stringifyValue(v, indent + 2, 0))
        );
        return [fl, ...rest].join("\n");
      }
      return pad + "- " + stringifyValue(item, indent + 2, inlineDepth + 1);
    }).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as { [k: string]: YamlValue });
    if (entries.length === 0) return "{}";
    return entries.map(([k, v]) => {
      const key = shouldQuote(k) ? quoteStr(k) : k;
      if (v !== null && typeof v === "object") {
        if (Array.isArray(v) && v.length === 0) return pad + key + ": []";
        if (!Array.isArray(v) && Object.keys(v).length === 0) return pad + key + ": {}";
        return pad + key + ":\n" + stringifyValue(v, indent + 2, 0);
      }
      if (typeof v === "string" && v.includes("\n")) return pad + key + ": " + stringifyValue(v, indent, 0);
      return pad + key + ": " + stringifyValue(v, indent, inlineDepth + 1);
    }).join("\n");
  }
  return String(value);
}

/**
 * Stringify a JavaScript value to YAML.
 * Objects become block mappings. Arrays become block sequences.
 * Multiline strings use literal block scalar (|).
 * Ambiguous strings are double-quoted.
 */
export function stringifyYaml(value: YamlValue): string {
  return stringifyValue(value, 0, 0) + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "parse") {
    const input = args.length > 1 ? args.slice(1).join(" ") : await Bun.stdin.text();
    console.log(JSON.stringify(parseYaml(input), null, 2));
  } else if (cmd === "stringify") {
    const input = args.length > 1 ? args.slice(1).join(" ") : await Bun.stdin.text();
    console.log(stringifyYaml(JSON.parse(input)));
  } else {
    console.log("Usage:");
    console.log("  bun packages/tools/yaml-lite.ts parse <yaml>");
    console.log("  bun packages/tools/yaml-lite.ts stringify <json>");
  }
}
