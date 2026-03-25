/**
 * JSONPath query engine - lightweight nested value extraction from JSON objects.
 * Supports dot notation, bracket notation, wildcards (*), and array slicing ([start:end]).
 *
 * Usage:
 *   query({ a: { b: [1, 2, 3] } }, "a.b[1]")  // => 2
 *   query(data, "users[*].name")               // => ["Alice", "Bob"]
 *   query(data, "items[0:2]")                  // => [item0, item1]
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type Segment =
  | { type: "key"; key: string }
  | { type: "index"; index: number }
  | { type: "wildcard" }
  | { type: "slice"; start: number | null; end: number | null };

/** Parse a path string into segments. */
function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  const len = path.length;

  while (i < len) {
    if (path[i] === ".") {
      i++; // skip dot
      continue;
    }

    if (path[i] === "[") {
      i++; // skip [
      let inner = "";
      while (i < len && path[i] !== "]") {
        inner += path[i++];
      }
      i++; // skip ]

      if (inner === "*") {
        segments.push({ type: "wildcard" });
      } else if (inner.includes(":")) {
        const [startStr, endStr] = inner.split(":");
        const start = startStr === "" ? null : parseInt(startStr, 10);
        const end = endStr === "" ? null : parseInt(endStr, 10);
        segments.push({ type: "slice", start, end });
      } else {
        const idx = parseInt(inner, 10);
        if (!isNaN(idx)) {
          segments.push({ type: "index", index: idx });
        } else {
          // bracket key notation like ["key"] or ['key']
          const cleaned = inner.replace(/^['"]|['"]$/g, "");
          segments.push({ type: "key", key: cleaned });
        }
      }
    } else {
      // Read key until . or [
      let key = "";
      while (i < len && path[i] !== "." && path[i] !== "[") {
        key += path[i++];
      }
      if (key === "*") {
        segments.push({ type: "wildcard" });
      } else if (key) {
        segments.push({ type: "key", key });
      }
    }
  }

  return segments;
}

/** Apply a single segment to one or more nodes, returning an array of results. */
function applySegment(nodes: JsonValue[], segment: Segment): JsonValue[] {
  const results: JsonValue[] = [];

  for (const node of nodes) {
    if (segment.type === "key") {
      if (node !== null && typeof node === "object" && !Array.isArray(node)) {
        const val = (node as Record<string, JsonValue>)[segment.key];
        if (val !== undefined) results.push(val);
      }
    } else if (segment.type === "index") {
      if (Array.isArray(node)) {
        const idx = segment.index < 0 ? node.length + segment.index : segment.index;
        if (idx >= 0 && idx < node.length) results.push(node[idx]);
      }
    } else if (segment.type === "wildcard") {
      if (Array.isArray(node)) {
        results.push(...node);
      } else if (node !== null && typeof node === "object") {
        results.push(...Object.values(node as Record<string, JsonValue>));
      }
    } else if (segment.type === "slice") {
      if (Array.isArray(node)) {
        const len = node.length;
        const rawStart = segment.start ?? 0;
        const rawEnd = segment.end ?? len;
        const start = rawStart < 0 ? Math.max(0, len + rawStart) : Math.min(rawStart, len);
        const end = rawEnd < 0 ? Math.max(0, len + rawEnd) : Math.min(rawEnd, len);
        results.push(...node.slice(start, end));
      }
    }
  }

  return results;
}

/**
 * Query a JSON value using a JSONPath-like expression.
 *
 * @param obj  - The root JSON value to query against.
 * @param path - Path expression (e.g. "a.b[0]", "items[*].name", "data[1:3]").
 * @returns    - A single value, an array of values for wildcards/slices, or undefined if not found.
 */
export function query(obj: JsonValue, path: string): JsonValue | undefined {
  if (!path || path === "$" || path === ".") return obj;

  // Strip leading $ or $.
  const normalized = path.replace(/^\$\.?/, "");
  if (!normalized) return obj;

  const segments = parsePath(normalized);
  let nodes: JsonValue[] = [obj];

  for (const segment of segments) {
    nodes = applySegment(nodes, segment);
    if (nodes.length === 0) return undefined;
  }

  // Wildcards and slices always return arrays; single-value paths return scalar
  const lastSeg = segments[segments.length - 1];
  if (lastSeg?.type === "wildcard" || lastSeg?.type === "slice") {
    return nodes;
  }

  return nodes.length === 1 ? nodes[0] : nodes;
}

/**
 * Query and return all matches as a flat array. Never returns undefined.
 */
export function queryAll(obj: JsonValue, path: string): JsonValue[] {
  const result = query(obj, path);
  if (result === undefined) return [];
  if (Array.isArray(result)) return result;
  return [result];
}
