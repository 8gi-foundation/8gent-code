/**
 * Deterministic object hashing with sorted keys.
 * Handles Date, Set, Map, RegExp, Buffer, circular references.
 */

export interface HashOptions {
  /** Algorithm to use for final hash. Default: "sha256" */
  algorithm?: "sha256" | "sha1" | "md5";
  /** Encoding for output. Default: "hex" */
  encoding?: "hex" | "base64";
  /** Whether to sort keys. Default: true */
  sortKeys?: boolean;
  /** Whether to include constructor name in type tag. Default: true */
  coerceTypes?: boolean;
}

const DEFAULT_OPTIONS: Required<HashOptions> = {
  algorithm: "sha256",
  encoding: "hex",
  sortKeys: true,
  coerceTypes: false,
};

/**
 * Serialise any JS value to a deterministic string, handling special types
 * and circular references via a seen-WeakSet sentinel.
 */
function serialise(
  value: unknown,
  sortKeys: boolean,
  seen: WeakSet<object>
): string {
  if (value === null) return "null:";
  if (value === undefined) return "undefined:";

  const type = typeof value;

  if (type === "boolean") return `bool:${value}`;
  if (type === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (!Number.isFinite(value as number))
      return `number:${value > 0 ? "+Inf" : "-Inf"}`;
    return `number:${value}`;
  }
  if (type === "bigint") return `bigint:${value}`;
  if (type === "string") return `string:${(value as string).length}:${value}`;
  if (type === "symbol") return `symbol:${(value as symbol).toString()}`;
  if (type === "function") return `function:${(value as Function).name}`;

  // Object types from here
  const obj = value as object;

  if (seen.has(obj)) return "circular:[Circular]";
  seen.add(obj);

  let result: string;

  if (obj instanceof Date) {
    result = `Date:${obj.toISOString()}`;
  } else if (obj instanceof RegExp) {
    result = `RegExp:${obj.source}:${obj.flags}`;
  } else if (typeof Buffer !== "undefined" && Buffer.isBuffer(obj)) {
    result = `Buffer:${(obj as Buffer).toString("hex")}`;
  } else if (obj instanceof Set) {
    const items = Array.from(obj as Set<unknown>)
      .map((v) => serialise(v, sortKeys, seen))
      .sort(); // sets are unordered - always sort
    result = `Set:[${items.join(",")}]`;
  } else if (obj instanceof Map) {
    const pairs = Array.from((obj as Map<unknown, unknown>).entries()).map(
      ([k, v]) => `${serialise(k, sortKeys, seen)}=>${serialise(v, sortKeys, seen)}`
    );
    if (sortKeys) pairs.sort();
    result = `Map:{${pairs.join(",")}}`;
  } else if (Array.isArray(obj)) {
    const items = (obj as unknown[]).map((v) => serialise(v, sortKeys, seen));
    result = `Array:[${items.join(",")}]`;
  } else {
    // Plain object
    let keys = Object.keys(obj);
    if (sortKeys) keys = keys.sort();
    const pairs = keys.map(
      (k) => `${k}:${serialise((obj as Record<string, unknown>)[k], sortKeys, seen)}`
    );
    result = `Object:{${pairs.join(",")}}`;
  }

  seen.delete(obj);
  return result;
}

async function digest(
  data: string,
  algorithm: "sha256" | "sha1" | "md5",
  encoding: "hex" | "base64"
): Promise<string> {
  const algoMap = { sha256: "SHA-256", sha1: "SHA-1", md5: "MD5" } as const;
  const encoded = new TextEncoder().encode(data);

  // Use Web Crypto if available (Node 16+, Bun, browser)
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest(algoMap[algorithm], encoded);
    const bytes = new Uint8Array(hashBuffer);
    if (encoding === "hex") {
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    // base64
    return btoa(String.fromCharCode(...bytes));
  }

  // Node.js fallback
  const { createHash } = await import("crypto");
  return createHash(algorithm).update(data).digest(encoding);
}

/**
 * Compute a deterministic hash of any JavaScript value.
 * Keys are sorted by default to ensure consistent hashes across object
 * construction order.
 */
export async function objectHash(
  obj: unknown,
  options: HashOptions = {}
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const serialised = serialise(obj, opts.sortKeys, new WeakSet());
  return digest(serialised, opts.algorithm, opts.encoding);
}

/**
 * Return true if two values produce the same deterministic hash.
 */
export async function hashEqual(
  a: unknown,
  b: unknown,
  options?: HashOptions
): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    objectHash(a, options),
    objectHash(b, options),
  ]);
  return ha === hb;
}

/**
 * Hash an object ignoring key insertion order (sortKeys always true).
 * Convenience wrapper that makes sortKeys non-optional.
 */
export async function hashStable(
  obj: unknown,
  options?: Omit<HashOptions, "sortKeys">
): Promise<string> {
  return objectHash(obj, { ...options, sortKeys: true });
}
