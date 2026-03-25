import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

export interface LockOptions {
  /** Max attempts before giving up. Default: 10 */
  maxRetries?: number;
  /** Initial backoff in ms. Doubles each retry. Default: 50 */
  initialBackoff?: number;
  /** Max backoff cap in ms. Default: 2000 */
  maxBackoff?: number;
  /** Stale lock age in ms (PID missing or process dead). Default: 30000 */
  staleAge?: number;
  /** Extra metadata to store in the lock file */
  metadata?: Record<string, unknown>;
}

export interface LockInfo {
  pid: number;
  timestamp: number;
  hostname: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_OPTS: Required<Omit<LockOptions, "metadata">> = {
  maxRetries: 10,
  initialBackoff: 50,
  maxBackoff: 2000,
  staleAge: 30_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

function isStale(info: LockInfo, staleAge: number): boolean {
  const age = Date.now() - info.timestamp;
  if (age > staleAge) return true;
  return !isProcessAlive(info.pid);
}

function writeLock(lockPath: string, metadata?: Record<string, unknown>): void {
  const info: LockInfo = {
    pid: process.pid,
    timestamp: Date.now(),
    hostname: process.env.HOSTNAME ?? "unknown",
    ...(metadata ? { metadata } : {}),
  };
  writeFileSync(lockPath, JSON.stringify(info, null, 2), { flag: "wx" });
}

/** Returns true if the lock at `lockPath` is currently held by a live process. */
export function isLocked(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const info = readLockInfo(lockPath);
  if (!info) return false;
  if (isStale(info, DEFAULT_OPTS.staleAge)) {
    try { unlinkSync(lockPath); } catch { /* best effort */ }
    return false;
  }
  return true;
}

/** Release a lock held by the current process. No-op if not held by us. */
export function releaseLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  const info = readLockInfo(lockPath);
  if (info && info.pid === process.pid) {
    try { unlinkSync(lockPath); } catch { /* best effort */ }
  }
}

/**
 * Acquire a lock file at `lockPath`.
 * Returns a release function, or throws if unable to acquire within retries.
 *
 * @example
 * const release = await acquireLock('/tmp/my-resource.lock');
 * try { ... } finally { release(); }
 */
export async function acquireLock(
  lockPath: string,
  options?: LockOptions
): Promise<() => void> {
  const opts = { ...DEFAULT_OPTS, ...options };
  let backoff = opts.initialBackoff;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (existsSync(lockPath)) {
      const info = readLockInfo(lockPath);
      if (info && isStale(info, opts.staleAge)) {
        try { unlinkSync(lockPath); } catch { /* another process may have cleaned up */ }
      }
    }

    try {
      writeLock(lockPath, opts.metadata);

      // Register auto-release on process exit
      const cleanup = () => releaseLock(lockPath);
      process.once("exit", cleanup);
      process.once("SIGINT", cleanup);
      process.once("SIGTERM", cleanup);

      return () => {
        releaseLock(lockPath);
        process.off("exit", cleanup);
        process.off("SIGINT", cleanup);
        process.off("SIGTERM", cleanup);
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err; // unexpected error
    }

    if (attempt < opts.maxRetries) {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, opts.maxBackoff);
    }
  }

  throw new Error(
    `acquireLock: failed to acquire "${lockPath}" after ${opts.maxRetries} retries`
  );
}
