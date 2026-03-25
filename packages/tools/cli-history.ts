/**
 * CLI History Manager for 8gent
 *
 * Stores command history in ~/.8gent/history as newline-delimited JSON.
 * Supports search, recall by index, and favorite commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface HistoryEntry {
  command: string;
  timestamp: number;
  favorite: boolean;
}

const HISTORY_DIR = join(homedir(), ".8gent");
const HISTORY_FILE = join(HISTORY_DIR, "history");
const MAX_ENTRIES = 5000;

function ensureDir(): void {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
}

function readAll(): HistoryEntry[] {
  ensureDir();
  if (!existsSync(HISTORY_FILE)) return [];
  const raw = readFileSync(HISTORY_FILE, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as HistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is HistoryEntry => e !== null);
}

function writeAll(entries: HistoryEntry[]): void {
  ensureDir();
  writeFileSync(HISTORY_FILE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Append a command to history. Trims to MAX_ENTRIES if needed. */
export function add(command: string): void {
  ensureDir();
  const entry: HistoryEntry = { command, timestamp: Date.now(), favorite: false };
  appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
  const all = readAll();
  if (all.length > MAX_ENTRIES) {
    writeAll(all.slice(all.length - MAX_ENTRIES));
  }
}

/** Return the last `n` history entries (default 20). */
export function recent(n = 20): HistoryEntry[] {
  return readAll().slice(-n);
}

/** Recall a single entry by 1-based index from the end (1 = most recent). */
export function recall(index: number): HistoryEntry | null {
  const all = readAll();
  if (index < 1 || index > all.length) return null;
  return all[all.length - index];
}

/** Search history by substring match (case-insensitive). */
export function search(query: string): HistoryEntry[] {
  const q = query.toLowerCase();
  return readAll().filter((e) => e.command.toLowerCase().includes(q));
}

/** Toggle favorite on the most recent entry matching the command string. */
export function toggleFavorite(command: string): boolean {
  const all = readAll();
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].command === command) {
      all[i].favorite = !all[i].favorite;
      writeAll(all);
      return all[i].favorite;
    }
  }
  return false;
}

/** Return all favorited commands. */
export function favorites(): HistoryEntry[] {
  return readAll().filter((e) => e.favorite);
}

/** Clear all history. */
export function clear(): void {
  ensureDir();
  writeFileSync(HISTORY_FILE, "");
}
