/**
 * StateHistory<T> - undo/redo state history for any value type.
 *
 * Configurable max depth. No external deps. No magic.
 *
 * Usage:
 *   const h = new StateHistory<number>({ maxHistory: 10 });
 *   h.push(1); h.push(2); h.push(3);
 *   h.undo();    // returns 2
 *   h.redo();    // returns 3
 */

export interface StateHistoryOptions {
  /** Maximum number of states to retain (including current). Default: 50. */
  maxHistory?: number;
}

export class StateHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private _current: T | undefined = undefined;
  private readonly maxHistory: number;

  constructor(options: StateHistoryOptions = {}) {
    this.maxHistory = options.maxHistory ?? 50;
  }

  /**
   * Push a new state. Clears any redo future and enforces maxHistory cap.
   */
  push(state: T): void {
    if (this._current !== undefined) {
      this.past.push(this._current);
    }

    // Enforce cap - oldest states are dropped first
    if (this.past.length >= this.maxHistory) {
      this.past = this.past.slice(this.past.length - (this.maxHistory - 1));
    }

    this._current = state;
    this.future = [];
  }

  /**
   * Step back one state. Returns the previous state, or undefined if at start.
   */
  undo(): T | undefined {
    if (this.past.length === 0) return undefined;

    if (this._current !== undefined) {
      this.future.unshift(this._current);
    }

    this._current = this.past.pop();
    return this._current;
  }

  /**
   * Step forward one state. Returns the next state, or undefined if at end.
   */
  redo(): T | undefined {
    if (this.future.length === 0) return undefined;

    if (this._current !== undefined) {
      this.past.push(this._current);
    }

    this._current = this.future.shift();
    return this._current;
  }

  /**
   * Returns the current state without moving the cursor.
   */
  current(): T | undefined {
    return this._current;
  }

  /**
   * True if undo() will return a state.
   */
  canUndo(): boolean {
    return this.past.length > 0;
  }

  /**
   * True if redo() will return a state.
   */
  canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * Wipes all state. Resets to empty as if newly constructed.
   */
  clear(): void {
    this.past = [];
    this.future = [];
    this._current = undefined;
  }

  /**
   * Snapshot of current history depth (past + current, not future).
   */
  size(): number {
    return this.past.length + (this._current !== undefined ? 1 : 0);
  }

  /**
   * Full ordered list of all states: [...past, current, ...future].
   * Useful for debugging or UI timeline display.
   */
  timeline(): T[] {
    const result: T[] = [...this.past];
    if (this._current !== undefined) result.push(this._current);
    result.push(...this.future);
    return result;
  }
}
