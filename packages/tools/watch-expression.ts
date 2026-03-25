/**
 * watch-expression.ts
 * Watches object properties (including deep paths) and evaluates expressions
 * on change. Triggers registered callbacks when conditions are met.
 */

export type WatchCallback = (value: unknown, prev: unknown, path: string) => void;

export interface WatchOptions {
  /** Dot-separated path to watch, e.g. "user.profile.age" */
  path: string;
  /** Optional condition expression - callback fires only when this returns true */
  condition?: (value: unknown, prev: unknown) => boolean;
  /** Callback invoked when the watched value changes (and condition passes) */
  callback: WatchCallback;
  /** Watch deeply nested changes under the path (default: false) */
  deep?: boolean;
}

interface Registration {
  options: WatchOptions;
  lastValue: unknown;
}

/** Retrieve a value at a dot-separated path from an object. */
function getAtPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce((acc: unknown, key: string) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/** Deep-clone a value using structured clone where available, else JSON round-trip. */
function snapshot(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object" && typeof value !== "function") return value;
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}

/** Shallow equality check for primitive values; reference check for objects. */
function hasChanged(a: unknown, b: unknown, deep: boolean): boolean {
  if (a === b) return false;
  if (deep && typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return true;
}

/**
 * Watcher - registers watch expressions on a target object and evaluates them
 * on each poll cycle. Use `start()` to begin polling and `stop()` to end it.
 */
export class Watcher {
  private target: Record<string, unknown>;
  private registrations: Map<string, Registration[]> = new Map();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private pollMs: number;

  /**
   * @param target   The root object to watch.
   * @param pollMs   Poll interval in milliseconds (default: 100).
   */
  constructor(target: Record<string, unknown>, pollMs = 100) {
    this.target = target;
    this.pollMs = pollMs;
  }

  /** Register a watch expression. Returns an unwatch function. */
  watch(options: WatchOptions): () => void {
    const { path } = options;
    const initial = snapshot(getAtPath(this.target, path));
    const reg: Registration = { options, lastValue: initial };

    if (!this.registrations.has(path)) {
      this.registrations.set(path, []);
    }
    this.registrations.get(path)!.push(reg);

    return () => this.unwatch(path, reg);
  }

  /** Remove a specific registration. */
  private unwatch(path: string, reg: Registration): void {
    const list = this.registrations.get(path);
    if (!list) return;
    const idx = list.indexOf(reg);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.registrations.delete(path);
  }

  /** Remove all watches. */
  unwatchAll(): void {
    this.registrations.clear();
  }

  /** Begin polling the target object at the configured interval. */
  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.evaluate(), this.pollMs);
  }

  /** Stop polling. */
  stop(): void {
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  /** Run a single evaluation pass over all registered watches. */
  evaluate(): void {
    for (const [path, list] of this.registrations) {
      const current = getAtPath(this.target, path);
      for (const reg of list) {
        const deep = reg.options.deep ?? false;
        if (hasChanged(reg.lastValue, current, deep)) {
          const prev = reg.lastValue;
          reg.lastValue = snapshot(current);
          const condition = reg.options.condition;
          if (!condition || condition(current, prev)) {
            reg.options.callback(current, prev, path);
          }
        }
      }
    }
  }

  /** Update the target object (e.g. replace state root). */
  setTarget(target: Record<string, unknown>): void {
    this.target = target;
  }
}
