/**
 * snapshot-differ.ts
 * Deep-compares two object snapshots and reports added, removed, and changed paths.
 * Handles nested objects and arrays. Produces a human-readable diff.
 */

export type DiffKind = "added" | "removed" | "changed";

export interface DiffEntry {
  kind: DiffKind;
  path: string;
  before?: unknown;
  after?: unknown;
}

export interface SnapshotDiff {
  entries: DiffEntry[];
  summary: string;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function isArray(val: unknown): val is unknown[] {
  return Array.isArray(val);
}

function serialize(val: unknown): string {
  if (val === undefined) return "undefined";
  if (val === null) return "null";
  if (typeof val === "string") return JSON.stringify(val);
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

function walk(
  before: unknown,
  after: unknown,
  path: string,
  entries: DiffEntry[]
): void {
  // Both plain objects - recurse into keys
  if (isObject(before) && isObject(after)) {
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of allKeys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasB = Object.prototype.hasOwnProperty.call(before, key);
      const hasA = Object.prototype.hasOwnProperty.call(after, key);
      if (!hasB) {
        entries.push({ kind: "added", path: childPath, after: after[key] });
      } else if (!hasA) {
        entries.push({ kind: "removed", path: childPath, before: before[key] });
      } else {
        walk(before[key], after[key], childPath, entries);
      }
    }
    return;
  }

  // Both arrays - compare by index
  if (isArray(before) && isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= before.length) {
        entries.push({ kind: "added", path: childPath, after: after[i] });
      } else if (i >= after.length) {
        entries.push({ kind: "removed", path: childPath, before: before[i] });
      } else {
        walk(before[i], after[i], childPath, entries);
      }
    }
    return;
  }

  // Primitive or type mismatch - compare by serialized value
  if (serialize(before) !== serialize(after)) {
    entries.push({ kind: "changed", path: path || "(root)", before, after });
  }
}

function formatEntry(entry: DiffEntry): string {
  switch (entry.kind) {
    case "added":
      return `+ ${entry.path}: ${serialize(entry.after)}`;
    case "removed":
      return `- ${entry.path}: ${serialize(entry.before)}`;
    case "changed":
      return `~ ${entry.path}: ${serialize(entry.before)} -> ${serialize(entry.after)}`;
  }
}

/**
 * Compares two object snapshots and returns a structured + human-readable diff.
 *
 * @param before - The snapshot taken before the agent turn
 * @param after  - The snapshot taken after the agent turn
 * @returns SnapshotDiff with structured entries and a readable summary string
 */
export function diffSnapshots(before: unknown, after: unknown): SnapshotDiff {
  const entries: DiffEntry[] = [];
  walk(before, after, "", entries);

  const added = entries.filter((e) => e.kind === "added").length;
  const removed = entries.filter((e) => e.kind === "removed").length;
  const changed = entries.filter((e) => e.kind === "changed").length;

  const summaryLine =
    entries.length === 0
      ? "No changes detected."
      : `${entries.length} change(s): +${added} added, -${removed} removed, ~${changed} changed`;

  const lines = [summaryLine, ...entries.map(formatEntry)];
  const summary = lines.join("\n");

  return { entries, summary };
}
