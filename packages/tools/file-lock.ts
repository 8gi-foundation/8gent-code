/**
 * Advisory file locking for cross-process synchronization.
 * Uses a .lock sidecar file containing the owner PID + timestamp.
 * Stale locks (owner PID gone) are automatically broken.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

export interface LockOptions {
  /** Max time (ms) to retry acquiring lock. Default: 5000 */
  timeout?: number;
  /** Initial retry interval (ms). Doubles each attempt, capped at 500ms. Default: 50 */
  retryInterval?: number;
  /** Max age (ms) before a lock is considered stale regardless of PID. Default: 60000 */
  staleAfter?: number;
}

interface LockFile {
  pid: number;
  timestamp: number;
}

function lockPath(filePath: string): string {
  return filePath + ".lock";
}

function readLock(lp: string): LockFile | null {
  try {
    const raw = readFileSync(lp, "utf8");
    return JSON.parse(raw) as LockFile;
  } catch {
    return null;
  }
}

function writeLock(lp: string): void {
  const data: LockFile = { pid: process.pid, timestamp: Date.now() };
  writeFileSync(lp, JSON.stringify(data), { flag: "wx" });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStale(lock: LockFile, staleAfter: number): boolean {
  if (Date.now() - lock.timestamp > staleAfter) return true;
  return !pidAlive(lock.pid);
}

function breakStaleLock(lp: string, staleAfter: number): boolean {
  const lock = readLock(lp);
  if (!lock) return true; // already gone
  if (isStale(lock, staleAfter)) {
    try {
      rmSync(lp);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Acquire a lock for the given file path.
 * Returns true if acquired, throws on timeout.
 */
export async function lockFile(
  filePath: string,
  options: LockOptions = {}
): Promise<void> {
  const {
    timeout = 5000,
    retryInterval = 50,
    staleAfter = 60_000,
  } = options;

  const lp = lockPath(filePath);
  const deadline = Date.now() + timeout;
  let interval = retryInterval;

  while (true) {
    // Try to break stale lock first
    if (existsSync(lp)) {
      breakStaleLock(lp, staleAfter);
    }

    // Attempt atomic create
    if (!existsSync(lp)) {
      try {
        writeLock(lp);
        return; // acquired
      } catch {
        // Race - another process created it first, fall through to retry
      }
    }

    if (Date.now() >= deadline) {
      const lock = readLock(lp);
      throw new Error(
        `file-lock: timeout acquiring lock for "${filePath}"` +
          (lock ? ` (held by PID ${lock.pid})` : "")
      );
    }

    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval * 2, 500);
  }
}

/**
 * Release the lock for the given file path.
 * Only removes if the current process owns the lock.
 */
export function unlockFile(filePath: string): void {
  const lp = lockPath(filePath);
  const lock = readLock(lp);
  if (!lock) return; // already unlocked
  if (lock.pid === process.pid) {
    try {
      rmSync(lp);
    } catch {
      // Ignore - already removed by another party
    }
  }
}

/**
 * Check if a file is currently locked (by any live process).
 */
export function isLocked(filePath: string, staleAfter = 60_000): boolean {
  const lp = lockPath(filePath);
  if (!existsSync(lp)) return false;
  const lock = readLock(lp);
  if (!lock) return false;
  return !isStale(lock, staleAfter);
}

/**
 * Acquire lock, run fn, then unconditionally release.
 * Preferred API - guarantees release on throw.
 */
export async function withLock<T>(
  filePath: string,
  fn: () => Promise<T> | T,
  options: LockOptions = {}
): Promise<T> {
  await lockFile(filePath, options);
  try {
    return await fn();
  } finally {
    unlockFile(filePath);
  }
}
