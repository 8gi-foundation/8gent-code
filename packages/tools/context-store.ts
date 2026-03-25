/**
 * context-store.ts
 *
 * Request-scoped context using AsyncLocalStorage.
 * Nested contexts inherit parent values; inner writes do not bleed upward.
 */

import { AsyncLocalStorage } from "async_hooks";

type ContextMap = Map<string, unknown>;

const storage = new AsyncLocalStorage<ContextMap>();

function active(): ContextMap | null {
  return storage.getStore() ?? null;
}

export class ContextStore {
  /**
   * Run fn inside a new context scope.
   * Values from context are merged on top of any inherited parent values.
   * Inner writes are scoped and do not mutate the parent.
   */
  run<T>(context: Record<string, unknown>, fn: () => T): T {
    const parent = storage.getStore();
    const map: ContextMap = parent ? new Map(parent) : new Map();
    for (const [k, v] of Object.entries(context)) {
      map.set(k, v);
    }
    return storage.run(map, fn);
  }

  /** Get a value from the current context. Returns undefined outside a scope. */
  get<T = unknown>(key: string): T | undefined {
    return active()?.get(key) as T | undefined;
  }

  /** Set a value in the current context. No-op outside a run() scope. */
  set<T = unknown>(key: string, value: T): void {
    const ctx = active();
    if (ctx) ctx.set(key, value);
  }

  /** Returns all key-value pairs in the current context as a plain object. */
  getAll(): Record<string, unknown> {
    const ctx = active();
    if (!ctx) return {};
    return Object.fromEntries(ctx.entries());
  }

  /** Returns true if the current context contains the given key. */
  has(key: string): boolean {
    return active()?.has(key) ?? false;
  }
}

/** Singleton instance for general use. */
export const contextStore = new ContextStore();

/**
 * createContext - namespaced accessor factory.
 * All keys are prefixed with namespace: to prevent cross-subsystem collisions.
 *
 * Example:
 *   const reqCtx = createContext("request");
 *   contextStore.run({}, () => {
 *     reqCtx.set("id", "abc-123");
 *     reqCtx.get("id"); // "abc-123"
 *   });
 */
export function createContext(namespace: string) {
  const nsKey = (key: string) => `${namespace}:${key}`;
  return {
    run<T>(values: Record<string, unknown>, fn: () => T): T {
      const namespaced: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) namespaced[nsKey(k)] = v;
      return contextStore.run(namespaced, fn);
    },
    get<T = unknown>(key: string): T | undefined {
      return contextStore.get<T>(nsKey(key));
    },
    set<T = unknown>(key: string, value: T): void {
      contextStore.set(nsKey(key), value);
    },
    has(key: string): boolean {
      return contextStore.has(nsKey(key));
    },
    getAll(): Record<string, unknown> {
      const all = contextStore.getAll();
      const prefix = `${namespace}:`;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith(prefix)) result[k.slice(prefix.length)] = v;
      }
      return result;
    },
  };
}
