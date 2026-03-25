/**
 * SnapshotStore - stores and compares state snapshots over time.
 * Standalone, no deps. Useful for debugging, rollback, and diff-based auditing.
 */

export interface Snapshot<T = unknown> {
  id: string;
  label?: string;
  state: T;
  timestamp: number;
}

export interface DiffResult {
  added: string[];
  removed: string[];
  changed: Array<{ key: string; from: unknown; to: unknown }>;
}

function generateId(): string {
  return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function flattenObject(
  obj: unknown,
  prefix = '',
  result: Record<string, unknown> = {}
): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object') {
    result[prefix] = obj;
    return result;
  }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flattenObject(value, fullKey, result);
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

export class SnapshotStore<T = unknown> {
  private snapshots: Snapshot<T>[] = [];

  /**
   * Capture the current state as a snapshot.
   * @param state - the state to capture
   * @param label - optional human-readable label
   */
  take(state: T, label?: string): Snapshot<T> {
    const snapshot: Snapshot<T> = {
      id: generateId(),
      label,
      state: structuredClone ? structuredClone(state) : JSON.parse(JSON.stringify(state)),
      timestamp: Date.now(),
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  /**
   * Return the most recent snapshot, or undefined if none exist.
   */
  latest(): Snapshot<T> | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  /**
   * Return all snapshots in chronological order.
   */
  list(): Snapshot<T>[] {
    return [...this.snapshots];
  }

  /**
   * Look up a snapshot by ID.
   */
  get(snapshotId: string): Snapshot<T> | undefined {
    return this.snapshots.find((s) => s.id === snapshotId);
  }

  /**
   * Roll back to a prior snapshot by ID.
   * Removes all snapshots taken after it and returns the target snapshot's state.
   * Returns undefined if the snapshot is not found.
   */
  rollback(snapshotId: string): T | undefined {
    const idx = this.snapshots.findIndex((s) => s.id === snapshotId);
    if (idx === -1) return undefined;
    this.snapshots = this.snapshots.slice(0, idx + 1);
    return structuredClone
      ? structuredClone(this.snapshots[idx].state)
      : JSON.parse(JSON.stringify(this.snapshots[idx].state));
  }

  /**
   * Compare two snapshots by ID. Returns added/removed/changed keys.
   * Uses dot-notation flattening for nested objects.
   */
  compare(snapshotIdA: string, snapshotIdB: string): DiffResult | undefined {
    const a = this.get(snapshotIdA);
    const b = this.get(snapshotIdB);
    if (!a || !b) return undefined;
    return this.diff(a, b);
  }

  /**
   * Diff two snapshot objects directly (no ID lookup).
   */
  diff(snapshotA: Snapshot<T>, snapshotB: Snapshot<T>): DiffResult {
    const flatA = flattenObject(snapshotA.state);
    const flatB = flattenObject(snapshotB.state);

    const keysA = new Set(Object.keys(flatA));
    const keysB = new Set(Object.keys(flatB));

    const added = [...keysB].filter((k) => !keysA.has(k));
    const removed = [...keysA].filter((k) => !keysB.has(k));
    const changed: DiffResult['changed'] = [];

    for (const key of keysA) {
      if (keysB.has(key) && JSON.stringify(flatA[key]) !== JSON.stringify(flatB[key])) {
        changed.push({ key, from: flatA[key], to: flatB[key] });
      }
    }

    return { added, removed, changed };
  }

  /**
   * Prune the snapshot list, keeping only the most recent N snapshots.
   */
  prune(keepN: number): void {
    if (this.snapshots.length > keepN) {
      this.snapshots = this.snapshots.slice(this.snapshots.length - keepN);
    }
  }

  /**
   * Clear all snapshots.
   */
  clear(): void {
    this.snapshots = [];
  }

  /**
   * Number of stored snapshots.
   */
  size(): number {
    return this.snapshots.length;
  }
}
