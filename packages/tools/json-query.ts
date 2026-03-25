/**
 * json-query: query JSON with simple path expressions.
 *
 * Supports:
 *   - Dot paths:           "a.b.c"
 *   - Array index:         "items[0]"
 *   - Wildcards:           "items[*].name"
 *   - Filters:             "items[?(@.active==true)]"
 *   - Recursive descent:   "..name"
 *   - Slice:               "items[0:3]"
 */

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

function applySegment(nodes: JsonValue[], segment: string): JsonValue[] {
  const result: JsonValue[] = [];

  for (const node of nodes) {
    if (segment === "") continue;

    const arrayMatch = segment.match(/^\[(.+)\]$/);
    if (arrayMatch) {
      const inner = arrayMatch[1].trim();

      if (inner === "*") {
        if (Array.isArray(node)) result.push(...node);
        else if (node && typeof node === "object") result.push(...Object.values(node));
        continue;
      }

      const sliceMatch = inner.match(/^(-?\d*):(-?\d*)$/);
      if (sliceMatch) {
        if (Array.isArray(node)) {
          const len = node.length;
          const start = sliceMatch[1] !== "" ? Number(sliceMatch[1]) : 0;
          const end = sliceMatch[2] !== "" ? Number(sliceMatch[2]) : len;
          const s = start < 0 ? Math.max(0, len + start) : Math.min(start, len);
          const e = end < 0 ? Math.max(0, len + end) : Math.min(end, len);
          result.push(...node.slice(s, e));
        }
        continue;
      }

      const filterMatch = inner.match(/^\?\(@\.(\w+)==(.+)\)$/);
      if (filterMatch) {
        const [, key, rawVal] = filterMatch;
        const expected = parseFilterValue(rawVal.trim());
        if (Array.isArray(node)) {
          for (const item of node) {
            if (item && typeof item === "object" && !Array.isArray(item)) {
              const obj = item as JsonObject;
              if (obj[key] === expected) result.push(item);
            }
          }
        }
        continue;
      }

      const idx = parseInt(inner, 10);
      if (!isNaN(idx) && Array.isArray(node)) {
        const actual = idx < 0 ? node.length + idx : idx;
        if (actual >= 0 && actual < node.length) result.push(node[actual]);
      }
      continue;
    }

    if (node && typeof node === "object" && !Array.isArray(node)) {
      const obj = node as JsonObject;
      if (segment in obj) result.push(obj[segment]);
    }
  }

  return result;
}

function parseFilterValue(raw: string): JsonValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const n = Number(raw);
  if (!isNaN(n)) return n;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function recursiveDescent(nodes: JsonValue[], key: string): JsonValue[] {
  const result: JsonValue[] = [];
  for (const node of nodes) {
    if (node && typeof node === "object") {
      if (!Array.isArray(node)) {
        const obj = node as JsonObject;
        if (key in obj) result.push(obj[key]);
        for (const child of Object.values(obj)) {
          result.push(...recursiveDescent([child], key));
        }
      } else {
        for (const item of node) {
          result.push(...recursiveDescent([item], key));
        }
      }
    }
  }
  return result;
}

/**
 * Query a JSON value with a path expression.
 *
 * @param data  - Any JSON-compatible value
 * @param expr  - Path expression string
 * @returns     - Array of matched values (empty array if nothing matched)
 *
 * @example
 * query({a:{b:1}}, "a.b")                          // [1]
 * query({items:[{x:1},{x:2}]}, "items[*].x")        // [1, 2]
 * query(data, "..name")                              // all "name" values at any depth
 * query(data, "items[?(@.active==true)]")            // filtered items
 * query(data, "items[0:3]")                          // first 3 items
 */
export function query(data: JsonValue, expr: string): JsonValue[] {
  if (!expr || expr.trim() === "" || expr.trim() === "$") return [data];

  let path = expr.trim().replace(/^\$\.?/, "");

  if (path.startsWith("..")) {
    const key = path.slice(2);
    return recursiveDescent([data], key);
  }

  const segments: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of path) {
    if (ch === "[") { depth++; current += ch; }
    else if (ch === "]") { depth--; current += ch; }
    else if (ch === "." && depth === 0) {
      if (current) segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) segments.push(current);

  const expanded: string[] = [];
  for (const seg of segments) {
    const m = seg.match(/^([^\[]+)(\[.+\])$/);
    if (m) {
      expanded.push(m[1], m[2]);
    } else {
      expanded.push(seg);
    }
  }

  let nodes: JsonValue[] = [data];
  for (const seg of expanded) {
    nodes = applySegment(nodes, seg);
    if (nodes.length === 0) break;
  }

  return nodes;
}
