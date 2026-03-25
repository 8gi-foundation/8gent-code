/**
 * type-generator.ts - Generate TypeScript interfaces from JSON samples.
 *
 * Infers string, number, boolean, null, arrays (homogeneous + tuple),
 * and nested objects. Outputs ready-to-use interface definitions.
 *
 * Usage:
 *   import { generateTypes } from './type-generator'
 *   const ts = generateTypes({ name: 'Ada', age: 30 }, 'User')
 *   // => "interface User { name: string; age: number; }"
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Generate TypeScript interface string from a JSON-compatible value. */
export function generateTypes(sample: unknown, rootName = 'Root'): string {
  const ctx: GenContext = { interfaces: [], seen: new Map() }
  inferType(sample, rootName, ctx)
  return ctx.interfaces.join('\n\n') + '\n'
}

/** Parse a JSON string then generate types. Throws on invalid JSON. */
export function generateTypesFromString(json: string, rootName = 'Root'): string {
  return generateTypes(JSON.parse(json), rootName)
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface GenContext {
  interfaces: string[]
  seen: Map<string, string> // fingerprint -> interface name (dedup)
}

function inferType(value: unknown, name: string, ctx: GenContext): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'

  if (Array.isArray(value)) {
    return inferArrayType(value, name, ctx)
  }

  if (typeof value === 'object') {
    return inferObjectType(value as Record<string, unknown>, name, ctx)
  }

  return 'unknown'
}

function inferArrayType(arr: unknown[], name: string, ctx: GenContext): string {
  if (arr.length === 0) return 'unknown[]'

  const itemName = singularize(name) + 'Item'
  const types = arr.map((item) => inferType(item, itemName, ctx))
  const unique = [...new Set(types)]

  if (unique.length === 1) return `${unique[0]}[]`

  // Mixed types - union
  return `(${unique.join(' | ')})[]`
}

function inferObjectType(
  obj: Record<string, unknown>,
  name: string,
  ctx: GenContext,
): string {
  const keys = Object.keys(obj).sort()
  if (keys.length === 0) return 'Record<string, unknown>'

  // Fingerprint for dedup - same shape reuses the same interface
  const fingerprint = buildFingerprint(obj)
  const existing = ctx.seen.get(fingerprint)
  if (existing) return existing

  ctx.seen.set(fingerprint, name)

  const fields = keys.map((key) => {
    const childName = pascalCase(key)
    const ts = inferType(obj[key], childName, ctx)
    const safeName = isSafeIdentifier(key) ? key : `'${escapeQuotes(key)}'`
    const nullable = obj[key] === null || obj[key] === undefined
    return `  ${safeName}${nullable ? '?' : ''}: ${ts};`
  })

  const block = `interface ${name} {\n${fields.join('\n')}\n}`
  ctx.interfaces.push(block)
  return name
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFingerprint(obj: Record<string, unknown>): string {
  return Object.keys(obj)
    .sort()
    .map((k) => `${k}:${primitiveTag(obj[k])}`)
    .join('|')
}

function primitiveTag(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function pascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase())
}

function singularize(s: string): string {
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y'
  if (s.endsWith('ses')) return s.slice(0, -2)
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1)
  return s
}

function isSafeIdentifier(s: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s)
}

function escapeQuotes(s: string): string {
  return s.replace(/'/g, "\\'")
}
