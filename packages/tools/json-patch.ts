/**
 * RFC 6902 JSON Patch implementation.
 * Supports: add, remove, replace, move, copy, test operations.
 * Also provides patch generation from object diffs and patch validation.
 */

export type PatchOpType = "add" | "remove" | "replace" | "move" | "copy" | "test";

export interface PatchOp {
  op: PatchOpType;
  path: string;
  value?: unknown;
  from?: string;
}

export class JsonPatchError extends Error {
  constructor(message: string, public readonly op?: PatchOp) {
    super(message);
    this.name = "JsonPatchError";
  }
}

/** Resolve a JSON Pointer (RFC 6901) path into an array of keys. */
function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new JsonPatchError(`Invalid pointer: ${pointer}`);
  return pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Get a value at a JSON Pointer path. Returns [parent, key, value]. */
function resolve(doc: unknown, pointer: string): { parent: unknown; key: string; value: unknown } {
  const keys = parsePointer(pointer);
  if (keys.length === 0) return { parent: null, key: "", value: doc };
  let current: unknown = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (Array.isArray(current)) {
      current = (current as unknown[])[parseInt(k, 10)];
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[k];
    } else {
      throw new JsonPatchError(`Cannot traverse into ${typeof current} at key "${k}"`);
    }
  }
  return { parent: current, key: keys[keys.length - 1], value: getAt(current, keys[keys.length - 1]) };
}

function getAt(target: unknown, key: string): unknown {
  if (Array.isArray(target)) return (target as unknown[])[parseInt(key, 10)];
  if (target !== null && typeof target === "object") return (target as Record<string, unknown>)[key];
  return undefined;
}

function setAt(target: unknown, key: string, value: unknown): void {
  if (Array.isArray(target)) {
    const idx = key === "-" ? (target as unknown[]).length : parseInt(key, 10);
    (target as unknown[]).splice(idx, 0, value);
  } else if (target !== null && typeof target === "object") {
    (target as Record<string, unknown>)[key] = value;
  }
}

function removeAt(target: unknown, key: string): unknown {
  if (Array.isArray(target)) {
    const idx = parseInt(key, 10);
    return (target as unknown[]).splice(idx, 1)[0];
  } else if (target !== null && typeof target === "object") {
    const rec = target as Record<string, unknown>;
    const val = rec[key];
    delete rec[key];
    return val;
  }
  throw new JsonPatchError(`Cannot remove from ${typeof target}`);
}

/** Apply RFC 6902 JSON Patch operations to a document (deep clone first). */
export function applyPatch<T = unknown>(doc: T, ops: PatchOp[]): T {
  let result = JSON.parse(JSON.stringify(doc)) as T;

  for (const op of ops) {
    const { parent, key } = resolve(result, op.path);

    switch (op.op) {
      case "add":
        if (op.path === "") { result = op.value as T; break; }
        setAt(parent, key, op.value);
        break;

      case "remove":
        if (op.path === "") throw new JsonPatchError("Cannot remove root", op);
        removeAt(parent, key);
        break;

      case "replace":
        if (op.path === "") { result = op.value as T; break; }
        if (getAt(parent, key) === undefined) throw new JsonPatchError(`Path not found: ${op.path}`, op);
        if (Array.isArray(parent)) (parent as unknown[])[parseInt(key, 10)] = op.value;
        else (parent as Record<string, unknown>)[key] = op.value;
        break;

      case "move": {
        if (!op.from) throw new JsonPatchError("move requires 'from'", op);
        const { parent: fromParent, key: fromKey, value: moved } = resolve(result, op.from);
        removeAt(fromParent, fromKey);
        const { parent: toParent, key: toKey } = resolve(result, op.path);
        setAt(toParent, toKey, moved);
        break;
      }

      case "copy": {
        if (!op.from) throw new JsonPatchError("copy requires 'from'", op);
        const { value: copied } = resolve(result, op.from);
        setAt(parent, key, JSON.parse(JSON.stringify(copied)));
        break;
      }

      case "test": {
        const { value: current } = resolve(result, op.path);
        if (JSON.stringify(current) !== JSON.stringify(op.value)) {
          throw new JsonPatchError(`Test failed at ${op.path}`, op);
        }
        break;
      }

      default:
        throw new JsonPatchError(`Unknown op: ${(op as PatchOp).op}`, op);
    }
  }

  return result;
}

/** Generate a minimal JSON Patch to transform `before` into `after`. */
export function generatePatch(before: unknown, after: unknown, path = ""): PatchOp[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before === null || after === null || typeof before !== typeof after ||
      Array.isArray(before) !== Array.isArray(after)) {
    return [{ op: "replace", path: path || "/", value: after }];
  }
  if (typeof before !== "object") return [{ op: "replace", path: path || "/", value: after }];

  const ops: PatchOp[] = [];
  const bKeys = Object.keys(before as object);
  const aKeys = Object.keys(after as object);
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;

  for (const k of bKeys) {
    const ptr = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (!(k in a)) ops.push({ op: "remove", path: ptr });
    else ops.push(...generatePatch(b[k], a[k], ptr));
  }
  for (const k of aKeys) {
    if (!(k in b)) {
      const ptr = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      ops.push({ op: "add", path: ptr, value: a[k] });
    }
  }
  return ops;
}

/** Validate patch ops structure. Returns array of error messages (empty = valid). */
export function validatePatch(ops: unknown[]): string[] {
  const errors: string[] = [];
  const valid = new Set(["add", "remove", "replace", "move", "copy", "test"]);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Record<string, unknown>;
    if (typeof op !== "object" || op === null) { errors.push(`op[${i}]: must be an object`); continue; }
    if (!op.op || !valid.has(op.op as string)) errors.push(`op[${i}]: invalid op "${op.op}"`);
    if (typeof op.path !== "string") errors.push(`op[${i}]: path must be a string`);
    if ((op.op === "move" || op.op === "copy") && typeof op.from !== "string")
      errors.push(`op[${i}]: ${op.op} requires a string 'from'`);
    if ((op.op === "add" || op.op === "replace" || op.op === "test") && !("value" in op))
      errors.push(`op[${i}]: ${op.op} requires a 'value'`);
  }
  return errors;
}
