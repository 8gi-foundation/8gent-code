/**
 * compact-json.ts
 *
 * Compact JSON serializer for token efficiency.
 * Strips nulls/undefined, omits defaults, shortens repeated string values,
 * enforces a depth limit, and estimates token savings.
 */

export interface CompactOptions {
  /** Max object depth. Deeper nodes are replaced with "...". Default: 6 */
  maxDepth?: number;
  /** Strip null and undefined values. Default: true */
  stripNulls?: boolean;
  /** Omit keys whose value matches the provided defaults map */
  defaults?: Record<string, unknown>;
  /** Deduplicate repeated string values using $ref pointers. Default: true */
  dedupeStrings?: boolean;
  /** Minimum string length eligible for deduplication. Default: 12 */
  dedupeMinLen?: number;
  /** Pretty-print output. Default: false */
  pretty?: boolean;
}

const DEFAULT_OPTS: Required<CompactOptions> = {
  maxDepth: 6,
  stripNulls: true,
  defaults: {},
  dedupeStrings: true,
  dedupeMinLen: 12,
  pretty: false,
};

/**
 * Compact-serialize a value, returning a JSON string with reduced token count.
 */
export function compactJSON(obj: unknown, options?: CompactOptions): string {
  const opts = { ...DEFAULT_OPTS, ...options };
  const stringRefs: Map<string, number> = new Map();
  const refTable: string[] = [];

  if (opts.dedupeStrings) {
    collectStrings(obj, opts, stringRefs, 0);
    // Keep only strings that appear more than once
    for (const [s, count] of stringRefs) {
      if (count > 1 && s.length >= opts.dedupeMinLen) {
        refTable.push(s);
      }
    }
    // Re-use stringRefs as index lookup
    stringRefs.clear();
    refTable.forEach((s, i) => stringRefs.set(s, i));
  }

  const compacted = compact(obj, opts, stringRefs, 0);

  const output: Record<string, unknown> =
    refTable.length > 0 ? { $r: refTable, $: compacted } : (compacted as Record<string, unknown>);

  return opts.pretty ? JSON.stringify(output, null, 2) : JSON.stringify(output);
}

/**
 * Estimate the token count of a value using a rough 4-chars-per-token heuristic.
 * Returns { original, compact, saved, ratio } token counts.
 */
export function estimateTokens(obj: unknown, options?: CompactOptions): {
  original: number;
  compact: number;
  saved: number;
  ratio: string;
} {
  const originalStr = JSON.stringify(obj) ?? "";
  const compactStr = compactJSON(obj, options);

  const original = Math.ceil(originalStr.length / 4);
  const compact = Math.ceil(compactStr.length / 4);
  const saved = original - compact;
  const ratio = original > 0 ? ((saved / original) * 100).toFixed(1) + "%" : "0%";

  return { original, compact, saved, ratio };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function compact(
  value: unknown,
  opts: Required<CompactOptions>,
  refs: Map<string, number>,
  depth: number
): unknown {
  if (depth > opts.maxDepth) return "...";

  if (value === null || value === undefined) {
    return opts.stripNulls ? undefined : value;
  }

  if (typeof value === "string") {
    if (opts.dedupeStrings && refs.has(value)) {
      return { $i: refs.get(value) };
    }
    return value;
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    const arr = value
      .map((item) => compact(item, opts, refs, depth + 1))
      .filter((item) => item !== undefined);
    return arr;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (opts.stripNulls && (v === null || v === undefined)) continue;
    if (k in opts.defaults && opts.defaults[k] === v) continue;

    const compacted = compact(v, opts, refs, depth + 1);
    if (compacted !== undefined) {
      result[k] = compacted;
    }
  }
  return result;
}

function collectStrings(
  value: unknown,
  opts: Required<CompactOptions>,
  acc: Map<string, number>,
  depth: number
): void {
  if (depth > opts.maxDepth) return;
  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (value.length >= opts.dedupeMinLen) {
      acc.set(value, (acc.get(value) ?? 0) + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const items = Array.isArray(value) ? value : Object.values(value as object);
  for (const item of items) {
    collectStrings(item, opts, acc, depth + 1);
  }
}
