/**
 * config-watcher.ts
 *
 * Watches a config file for changes and reloads it automatically.
 * Features:
 *   - Debounced reload (default 300ms) to coalesce rapid writes
 *   - Custom parser support (defaults to JSON.parse)
 *   - Validates parsed result before applying (user-supplied validator)
 *   - Rolls back to last-known-good config on parse error
 *   - onChange listeners notified after successful reload only
 */

import { watch, readFileSync, existsSync, type FSWatcher } from "fs";

export type Parser<T> = (raw: string) => T;
export type Validator<T> = (value: T) => boolean | string;
export type ChangeListener<T> = (current: T, previous: T) => void;

export interface WatchOptions<T> {
  /** Custom parse function. Defaults to JSON.parse. */
  parser?: Parser<T>;
  /** Optional validator. Return true to accept, false or a string (reason) to reject. */
  validator?: Validator<T>;
  /** Debounce delay in ms before reloading after a change event. Default: 300. */
  debounceMs?: number;
}

export class ConfigWatcher<T = unknown> {
  private filePath: string;
  private parser: Parser<T>;
  private validator: Validator<T> | undefined;
  private debounceMs: number;

  private current: T;
  private lastGood: T;
  private listeners: Array<ChangeListener<T>> = [];
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Construct a watcher. Does NOT start watching - call watch() explicitly.
   * @param filePath - Absolute or relative path to the config file.
   * @param options  - Parser, validator, debounce settings.
   */
  constructor(filePath: string, options: WatchOptions<T> = {}) {
    this.filePath = filePath;
    this.parser = options.parser ?? ((raw: string) => JSON.parse(raw) as T);
    this.validator = options.validator;
    this.debounceMs = options.debounceMs ?? 300;

    // Load initial value eagerly so current() is usable before watching starts.
    this.current = this.loadFile();
    this.lastGood = this.current;
  }

  /** Read and parse the file, throwing on error. */
  private loadFile(): T {
    if (!existsSync(this.filePath)) {
      throw new Error(`config-watcher: file not found: ${this.filePath}`);
    }
    const raw = readFileSync(this.filePath, "utf8");
    return this.parser(raw);
  }

  /** Validate a candidate value. Returns error string or null. */
  private validate(value: T): string | null {
    if (!this.validator) return null;
    const result = this.validator(value);
    if (result === true) return null;
    if (result === false) return "validation failed (no reason given)";
    return result;
  }

  /** Perform the actual reload: parse, validate, apply or rollback. */
  private reload(): void {
    let candidate: T;
    try {
      candidate = this.loadFile();
    } catch (err) {
      // Parse/read error - rollback silently (keep last good)
      console.error(
        `config-watcher: parse error in ${this.filePath} - rolling back`,
        err
      );
      return;
    }

    const validationError = this.validate(candidate);
    if (validationError !== null) {
      console.error(
        `config-watcher: validation rejected new config (${validationError}) - rolling back`
      );
      return;
    }

    const previous = this.current;
    this.current = candidate;
    this.lastGood = candidate;

    for (const listener of this.listeners) {
      try {
        listener(this.current, previous);
      } catch (err) {
        console.error("config-watcher: onChange listener threw", err);
      }
    }
  }

  /**
   * Start watching the file for changes.
   * Safe to call multiple times - subsequent calls are no-ops.
   */
  watch(): this {
    if (this.watcher) return this;

    this.watcher = watch(this.filePath, () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.reload();
      }, this.debounceMs);
    });

    return this;
  }

  /**
   * Register a listener called after each successful reload.
   * @returns Unsubscribe function.
   */
  onChange(fn: ChangeListener<T>): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Return the current (last-known-good) config value. */
  current_value(): T {
    return this.current;
  }

  /** Stop watching. Clears debounce timer and closes the fs.watch handle. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
