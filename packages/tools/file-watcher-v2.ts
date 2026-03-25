/**
 * file-watcher-v2.ts
 * Improved file watcher with recursive support, ignore patterns, debounce, and typed events.
 * Uses Node/Bun native fs.watch under the hood - zero extra deps.
 */

import * as fs from "fs";
import * as path from "path";

export type WatchEvent = "change" | "add" | "unlink";
export type WatchHandler = (filePath: string) => void;

export interface WatchOptions {
  /** Watch subdirectories recursively. Default: true */
  recursive?: boolean;
  /** Glob-style patterns to ignore (matched against full path). */
  ignore?: string[];
  /** Debounce window in ms to suppress duplicate events. Default: 100 */
  debounce?: number;
}

type InternalHandler = { event: WatchEvent; fn: WatchHandler };

export class Watcher {
  private _paths: string[];
  private _opts: Required<WatchOptions>;
  private _handlers: InternalHandler[] = [];
  private _readyHandlers: Array<() => void> = [];
  private _ignorePatterns: RegExp[] = [];
  private _watchers: fs.FSWatcher[] = [];
  private _debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _seenFiles: Set<string> = new Set();

  constructor(paths: string | string[], opts: WatchOptions = {}) {
    this._paths = Array.isArray(paths) ? paths : [paths];
    this._opts = {
      recursive: opts.recursive ?? true,
      ignore: opts.ignore ?? [],
      debounce: opts.debounce ?? 100,
    };
    this._buildIgnorePatterns(this._opts.ignore);
  }

  /** Register a handler for a specific watch event. Chainable. */
  on(event: WatchEvent, fn: WatchHandler): this {
    this._handlers.push({ event, fn });
    return this;
  }

  /** Register a handler that fires once all watched paths are ready. */
  ready(fn: () => void): this {
    this._readyHandlers.push(fn);
    return this;
  }

  /** Add additional ignore patterns after construction. */
  ignore(patterns: string | string[]): this {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    this._opts.ignore.push(...list);
    this._buildIgnorePatterns(this._opts.ignore);
    return this;
  }

  /** Start watching. Called automatically by watch() factory. */
  start(): this {
    for (const watchPath of this._paths) {
      this._initPath(watchPath);
    }
    // Emit ready after a tick so handlers can be registered first
    setTimeout(() => {
      for (const fn of this._readyHandlers) fn();
    }, 0);
    return this;
  }

  /** Stop all watchers and clear timers. */
  close(): void {
    for (const w of this._watchers) {
      try { w.close(); } catch { /* already closed */ }
    }
    this._watchers = [];
    for (const t of this._debounceTimers.values()) clearTimeout(t);
    this._debounceTimers.clear();
    this._seenFiles.clear();
  }

  private _initPath(watchPath: string): void {
    const resolved = path.resolve(watchPath);

    // Snapshot existing files so we can detect "add" vs "change"
    this._snapshotDir(resolved);

    const watcher = fs.watch(
      resolved,
      { recursive: this._opts.recursive, persistent: false },
      (eventType, filename) => {
        if (!filename) return;
        const full = path.join(resolved, filename);
        if (this._isIgnored(full)) return;
        this._debounce(full, () => this._dispatch(full));
      }
    );
    this._watchers.push(watcher);
  }

  private _snapshotDir(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { recursive: this._opts.recursive, withFileTypes: true });
      for (const e of entries as fs.Dirent[]) {
        if (e.isFile()) {
          const full = path.join((e as any).path ?? dir, e.name);
          this._seenFiles.add(full);
        }
      }
    } catch { /* dir may not exist yet */ }
  }

  private _dispatch(filePath: string): void {
    let event: WatchEvent;
    try {
      fs.accessSync(filePath);
      event = this._seenFiles.has(filePath) ? "change" : "add";
      this._seenFiles.add(filePath);
    } catch {
      event = "unlink";
      this._seenFiles.delete(filePath);
    }
    for (const h of this._handlers) {
      if (h.event === event) h.fn(filePath);
    }
  }

  private _debounce(key: string, fn: () => void): void {
    const existing = this._debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this._debounceTimers.set(key, setTimeout(() => {
      this._debounceTimers.delete(key);
      fn();
    }, this._opts.debounce));
  }

  private _buildIgnorePatterns(patterns: string[]): void {
    this._ignorePatterns = patterns.map((p) => {
      // Convert simple globs: * -> [^/]*, ** -> .*
      const escaped = p
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*");
      return new RegExp(escaped);
    });
  }

  private _isIgnored(filePath: string): boolean {
    return this._ignorePatterns.some((re) => re.test(filePath));
  }
}

/** Factory function - creates and starts a Watcher instance. */
export function watch(paths: string | string[], opts?: WatchOptions): Watcher {
  return new Watcher(paths, opts).start();
}
