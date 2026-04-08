/**
 * ClipboardSync - cross-process clipboard synchronization via shared temp file.
 * Uses a lock file to prevent concurrent write collisions.
 * Supports copy, paste, watch, and history operations.
 */

import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SYNC_FILE = join(tmpdir(), "8gent-clipboard.json");
const LOCK_FILE = join(tmpdir(), "8gent-clipboard.lock");
const LOCK_TIMEOUT_MS = 2000;
const HISTORY_MAX = 100;

interface ClipboardEntry {
  text: string;
  ts: number;
}

interface ClipboardStore {
  current: string;
  history: ClipboardEntry[];
}

function acquireLock(): boolean {
  const start = Date.now();
  while (existsSync(LOCK_FILE)) {
    if (Date.now() - start > LOCK_TIMEOUT_MS) return false;
    // spin - intentionally blocking for correctness on short critical sections
    const end = Date.now() + 5;
    while (Date.now() < end) {}
  }
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = readFileSync(LOCK_FILE, "utf8");
      if (pid === String(process.pid)) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // best-effort release
  }
}

function readStore(): ClipboardStore {
  if (!existsSync(SYNC_FILE)) {
    return { current: "", history: [] };
  }
  try {
    return JSON.parse(readFileSync(SYNC_FILE, "utf8")) as ClipboardStore;
  } catch {
    return { current: "", history: [] };
  }
}

function writeStore(store: ClipboardStore): void {
  writeFileSync(SYNC_FILE, JSON.stringify(store, null, 2), "utf8");
}

export class ClipboardSync {
  private watchers: Set<(text: string) => void> = new Set();
  private watching = false;

  /**
   * Write text to the shared clipboard. Previous value pushed to history.
   * Returns true on success, false if lock could not be acquired.
   */
  copy(text: string): boolean {
    if (!acquireLock()) return false;
    try {
      const store = readStore();
      if (store.current) {
        store.history.push({ text: store.current, ts: Date.now() });
        if (store.history.length > HISTORY_MAX) {
          store.history = store.history.slice(-HISTORY_MAX);
        }
      }
      store.current = text;
      writeStore(store);
      return true;
    } finally {
      releaseLock();
    }
  }

  /**
   * Read the current clipboard value.
   */
  paste(): string {
    return readStore().current;
  }

  /**
   * Watch for changes written by other processes.
   * Returns an unsubscribe function.
   */
  watch(callback: (text: string) => void): () => void {
    this.watchers.add(callback);
    if (!this.watching) {
      this.watching = true;
      let lastSeen = readStore().current;
      watchFile(SYNC_FILE, { interval: 300 }, () => {
        const current = readStore().current;
        if (current !== lastSeen) {
          lastSeen = current;
          for (const cb of this.watchers) cb(current);
        }
      });
    }
    return () => {
      this.watchers.delete(callback);
      if (this.watchers.size === 0) {
        this.watching = false;
        unwatchFile(SYNC_FILE);
      }
    };
  }

  /**
   * Return the last n items from history (most recent last).
   * Does not include the current clipboard value.
   */
  history(n = 10): string[] {
    const store = readStore();
    return store.history
      .slice(-n)
      .map((e) => e.text)
      .filter(Boolean);
  }

  /**
   * Clear clipboard and history.
   */
  clear(): boolean {
    if (!acquireLock()) return false;
    try {
      writeStore({ current: "", history: [] });
      return true;
    } finally {
      releaseLock();
    }
  }
}
