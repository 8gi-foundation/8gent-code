/**
 * Lifecycle hook system with before/after phases and priority ordering.
 * Hooks run in priority order (lower number = earlier execution).
 */

export type HookPhase = 'before' | 'after';

export type HookFn<T = Record<string, unknown>> = (
  context: T
) => Promise<T | void> | T | void;

export interface HookEntry<T = Record<string, unknown>> {
  id: string;
  name: string;
  phase: HookPhase;
  fn: HookFn<T>;
  priority: number;
}

export interface HookCallResult<T> {
  context: T;
  ran: string[];
  skipped: string[];
}

let _nextId = 1;

export class HookSystem<T extends Record<string, unknown> = Record<string, unknown>> {
  private hooks: Map<string, HookEntry<T>[]> = new Map();

  /**
   * Register a hook for a named lifecycle event.
   * Returns the hook ID - keep it to removeHook later.
   */
  addHook(
    name: string,
    phase: HookPhase,
    fn: HookFn<T>,
    priority = 50
  ): string {
    const id = `hook_${_nextId++}`;
    const entry: HookEntry<T> = { id, name, phase, fn, priority };

    const key = this._key(name, phase);
    const existing = this.hooks.get(key) ?? [];
    existing.push(entry);
    existing.sort((a, b) => a.priority - b.priority);
    this.hooks.set(key, existing);

    return id;
  }

  /**
   * Remove a previously registered hook by ID.
   * Returns true if the hook was found and removed.
   */
  removeHook(id: string): boolean {
    for (const [key, entries] of this.hooks.entries()) {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx !== -1) {
        entries.splice(idx, 1);
        if (entries.length === 0) {
          this.hooks.delete(key);
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Run all hooks for a given name and phase in priority order.
   * Each hook receives the (possibly mutated) context from the previous hook.
   * Returns the final context and a list of ran/skipped hook IDs.
   */
  async callHook(
    name: string,
    phase: HookPhase,
    context: T
  ): Promise<HookCallResult<T>> {
    const entries = this.hooks.get(this._key(name, phase)) ?? [];
    const ran: string[] = [];
    const skipped: string[] = [];

    let ctx = { ...context };

    for (const entry of entries) {
      try {
        const result = await entry.fn(ctx);
        if (result !== undefined && result !== null) {
          ctx = result as T;
        }
        ran.push(entry.id);
      } catch (err) {
        // Hook threw - skip it and continue
        skipped.push(entry.id);
        console.warn(`[HookSystem] Hook ${entry.id} (${name}:${phase}) threw:`, err);
      }
    }

    return { context: ctx, ran, skipped };
  }

  /**
   * List all registered hooks for a named event.
   * If phase is omitted, returns hooks for both phases.
   */
  listHooks(name: string, phase?: HookPhase): HookEntry<T>[] {
    if (phase) {
      return [...(this.hooks.get(this._key(name, phase)) ?? [])];
    }
    return [
      ...(this.hooks.get(this._key(name, 'before')) ?? []),
      ...(this.hooks.get(this._key(name, 'after')) ?? []),
    ];
  }

  /** Clear all hooks for a named event, or all hooks if name is omitted. */
  clear(name?: string): void {
    if (!name) {
      this.hooks.clear();
      return;
    }
    this.hooks.delete(this._key(name, 'before'));
    this.hooks.delete(this._key(name, 'after'));
  }

  private _key(name: string, phase: HookPhase): string {
    return `${name}:${phase}`;
  }
}
