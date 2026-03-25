/**
 * TypeScript type guard generator.
 * Parses interface and type alias definitions and generates isX() runtime
 * type guard functions for safe unknown-value narrowing.
 *
 * Usage:
 *   import { generateGuard } from "./type-guard-generator";
 *   const guards = generateGuard(`interface User { id: number; name: string; }`);
 */

export interface FieldDef {
  name: string;
  type: string;
  optional: boolean;
}

export interface ParsedType {
  name: string;
  fields: FieldDef[];
}

const TYPEOF_TYPES = new Set([
  "string", "number", "boolean", "bigint", "symbol", "undefined", "function",
]);

function normalizeType(t: string): string {
  return t.trim().replace(/;$/, "").trim();
}

function parseFields(body: string): FieldDef[] {
  const fields: FieldDef[] = [];
  const fieldRegex = /(\w+)(\?)?:\s*([^;
]+)/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRegex.exec(body)) !== null) {
    fields.push({ name: m[1], type: normalizeType(m[3]), optional: m[2] === "?" });
  }
  return fields;
}

function extractBraceBlock(source: string, start: number): string | null {
  let depth = 1, i = start;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return depth === 0 ? source.slice(start, i - 1) : null;
}

export function parseInterfaces(source: string): ParsedType[] {
  const results: ParsedType[] = [];
  let m: RegExpExecArray | null;

  const ifRe = /interface\s+(\w+)[^{]*\{/g;
  while ((m = ifRe.exec(source)) !== null) {
    const body = extractBraceBlock(source, m.index + m[0].length);
    if (body !== null) results.push({ name: m[1], fields: parseFields(body) });
  }

  const tyRe = /type\s+(\w+)\s*=\s*\{/g;
  while ((m = tyRe.exec(source)) !== null) {
    const body = extractBraceBlock(source, m.index + m[0].length);
    if (body !== null) results.push({ name: m[1], fields: parseFields(body) });
  }

  return results;
}

function buildCheck(v: string, field: string, type: string): string {
  const a = `${v}.${field}`;
  if (type.endsWith("[]")) return `Array.isArray(${a})`;
  if (type === "null") return `${a} === null`;

  const parts = type.split(/\s*\|\s*/).map((p) => p.trim());
  if (parts.length > 1) {
    return `(${parts.map((p) => buildCheck(v, field, p)).join(" || ")})`;
  }

  if (/^['"]/.test(type)) return `${a} === ${type}`;
  if (TYPEOF_TYPES.has(type)) return `typeof ${a} === "${type}"`;
  return `${a} !== null && typeof ${a} === "object"`;
}

export function generateGuardForType(parsed: ParsedType): string {
  const { name, fields } = parsed;
  const lines = [
    `export function is${name}(value: unknown): value is ${name} {`,
    `  if (value === null || typeof value !== "object") return false;`,
    `  const v = value as Record<string, unknown>;`,
  ];
  for (const f of fields) {
    const check = buildCheck("v", f.name, f.type);
    lines.push(f.optional
      ? `  if (v.${f.name} !== undefined && !(${check})) return false;`
      : `  if (!(${check})) return false;`);
  }
  lines.push("  return true;", "}");
  return lines.join("\n");
}

/**
 * Generate isX() type guard functions from TypeScript interface/type definitions.
 * @param interfaceCode - source containing interface or type alias definitions
 * @returns TypeScript source string with generated guard functions
 */
export function generateGuard(interfaceCode: string): string {
  const parsed = parseInterfaces(interfaceCode);
  if (parsed.length === 0) return "// No interfaces or type aliases found.";
  return parsed.map(generateGuardForType).join("\n\n");
}
