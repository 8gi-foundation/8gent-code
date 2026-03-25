/**
 * FileWatcher - watches files and directories for changes.
 * Supports glob pattern filtering, event debouncing, and typed events.
 * No external dependencies - uses Node/Bun built-in fs.watch.
 */

import fs from "fs";
import path from "path";
import { EventEmitter } from "events";

export type FileEventType = "change" | "rename" | "add" | "unlink";

export interface FileEvent {
  type: FileEventType;
  filePath: string;
  timestamp: number;
}

export interface FileWatcherOptions {
  /** Glob-style patterns matched against filename. Default: ["*"] */
  patterns?: string[];
  /** Debounce window in ms - collapses rapid events. Default: 100 */
  debounceMs?: number;
  /** Watch subdirectories recursively. Default: true */
  recursive?: boolean;
}

type FileWatcherEvents = {
  change: [event: FileEvent];
  rename: [event: FileEvent];
  add: [event: FileEvent];
  unlink: [event: FileEvent];
  error: [err: Error];
};

function matchGlob(pattern: string, filename: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(filename);
}

function matchesAnyPattern(patterns: string[], filePath: string): boolean {
  const filename = path.basename(filePath);
  return patterns.some((p) => matchGlob(p, filename));
}

export class FileWatcher extends EventEmitter<FileWatcherEvents> {
  private watchers: fs.FSWatcher[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private knownFiles = new Set<string>();
  private patterns: string[];
  private debounceMs: number;
  private recursive: boolean;
  private running = false;

  constructor(options: FileWatcherOptions = {}) {
    super();
    this.patterns = options.patterns ?? ["*"];
    this.debounceMs = options.debounceMs ?? 100;
    this.recursive = options.recursive ?? true;
  }

  /** Start watching a path (file or directory). */
  watch(target: string): this {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
      this.emit("error", new Error(`Path does not exist: ${resolved}`));
      return this;
    }
    this._snapshot(resolved);
    const watcher = fs.watch(
      resolved,
      { recursive: this.recursive },
      (eventType, filename) => {
        if (!filename) return;
        const filePath = path.join(resolved, filename);
        this._debounce(filePath, eventType as "change" | "rename");
      }
    );
    watcher.on("error", (err) => this.emit("error", err));
    this.watchers.push(watcher);
    this.running = true;
    return this;
  }

  /** Stop all watchers and clear debounce timers. */
  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.knownFiles.clear();
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private _snapshot(dir: string): void {
    try {
      const stat = fs.statSync(dir);
      if (stat.isFile()) { this.knownFiles.add(dir); return; }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && this.recursive) this._snapshot(full);
        else if (entry.isFile()) this.knownFiles.add(full);
      }
    } catch { /* unreadable - skip */ }
  }

  private _debounce(filePath: string, fsEvent: "change" | "rename"): void {
    if (!matchesAnyPattern(this.patterns, filePath)) return;
    const existing = this.timers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(filePath);
      this._dispatch(filePath, fsEvent);
    }, this.debounceMs);
    this.timers.set(filePath, timer);
  }

  private _dispatch(filePath: string, fsEvent: "change" | "rename"): void {
    const exists = fs.existsSync(filePath);
    let type: FileEventType;
    if (fsEvent === "rename") {
      if (exists && !this.knownFiles.has(filePath)) {
        type = "add";
        this.knownFiles.add(filePath);
      } else if (!exists && this.knownFiles.has(filePath)) {
        type = "unlink";
        this.knownFiles.delete(filePath);
      } else {
        type = "rename";
      }
    } else {
      type = "change";
    }
    this.emit(type, { type, filePath, timestamp: Date.now() });
  }
}
