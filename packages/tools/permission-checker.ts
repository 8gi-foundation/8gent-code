/**
 * permission-checker.ts
 *
 * Checks filesystem read/write/execute permissions before operations.
 * Prevents access errors by validating permissions upfront.
 */

import * as fs from "fs";
import * as path from "path";

export interface PermissionResult {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface OwnerInfo {
  uid: number;
  gid: number;
  isOwner: boolean;
  username: string;
}

/**
 * Checks if the current process can read the given path.
 */
export function canRead(filePath: string): boolean {
  try {
    fs.accessSync(path.resolve(filePath), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if the current process can write to the given path.
 * For non-existent paths, checks the parent directory.
 */
export function canWrite(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  try {
    fs.accessSync(resolved, fs.constants.W_OK);
    return true;
  } catch {
    // If path does not exist, check parent directory
    if (!fs.existsSync(resolved)) {
      const parent = path.dirname(resolved);
      try {
        fs.accessSync(parent, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Checks if the current process can execute the given path.
 */
export function canExecute(filePath: string): boolean {
  try {
    fs.accessSync(path.resolve(filePath), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a full permission report for read, write, and execute on a path.
 */
export function checkAll(filePath: string): PermissionResult {
  return {
    read: canRead(filePath),
    write: canWrite(filePath),
    execute: canExecute(filePath),
  };
}

/**
 * Ensures a path is writable. Throws a descriptive error if not.
 */
export function ensureWritable(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!canWrite(resolved)) {
    const exists = fs.existsSync(resolved);
    const target = exists ? resolved : path.dirname(resolved);
    throw new Error(
      `Permission denied: cannot write to "${resolved}". ` +
        `Check permissions on "${target}" (uid=${process.getuid?.() ?? "unknown"}).`
    );
  }
}

/**
 * Returns ownership info for a path.
 * Falls back gracefully on platforms without getuid (Windows).
 */
export function getOwner(filePath: string): OwnerInfo {
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  const currentUid = process.getuid?.() ?? -1;

  // Attempt to resolve username from uid via id command on Unix
  let username = String(stat.uid);
  try {
    const { execSync } = require("child_process");
    const result = execSync(`id -nu ${stat.uid}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    username = result.trim();
  } catch {
    // Non-Unix or command unavailable - fall back to uid string
  }

  return {
    uid: stat.uid,
    gid: stat.gid,
    isOwner: currentUid === stat.uid,
    username,
  };
}
