/**
 * file-fingerprint - stable content + metadata fingerprints for change detection
 * Quarantine status: not wired into agent tools yet
 */

import { createHash } from "crypto";
import { statSync, readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

export interface FingerprintOptions {
  /** Include file mtime in fingerprint (default: false - content-only by default) */
  includeMtime?: boolean;
  /** Include file size in fingerprint (default: true) */
  includeSize?: boolean;
  /** Hash algorithm (default: "sha256") */
  algorithm?: "sha256" | "sha1" | "md5";
}

export interface Fingerprint {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  algorithm: string;
  generatedAt: number;
}

export interface BatchResult {
  fingerprints: Record<string, Fingerprint>;
  totalFiles: number;
  totalBytes: number;
  generatedAt: number;
}

const DEFAULT_OPTIONS: Required<FingerprintOptions> = {
  includeMtime: false,
  includeSize: true,
  algorithm: "sha256",
};

/**
 * Generate a stable fingerprint for a single file.
 * By default uses content + size only (mtime excluded) for portability.
 */
export function fingerprint(
  filePath: string,
  options: FingerprintOptions = {}
): Fingerprint {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const stat = statSync(filePath);

  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const content = readFileSync(filePath);
  const hasher = createHash(opts.algorithm);

  hasher.update(content);

  if (opts.includeSize) {
    hasher.update(`:size=${stat.size}`);
  }

  if (opts.includeMtime) {
    hasher.update(`:mtime=${stat.mtimeMs}`);
  }

  return {
    path: filePath,
    hash: hasher.digest("hex"),
    size: stat.size,
    mtime: stat.mtimeMs,
    algorithm: opts.algorithm,
    generatedAt: Date.now(),
  };
}

/**
 * Check if a file has changed since a previous fingerprint was taken.
 * Returns true if changed or if the file cannot be read.
 */
export function hasChanged(
  filePath: string,
  previousFP: Fingerprint,
  options: FingerprintOptions = {}
): boolean {
  try {
    const current = fingerprint(filePath, {
      algorithm: previousFP.algorithm as FingerprintOptions["algorithm"],
      ...options,
    });
    return current.hash !== previousFP.hash;
  } catch {
    return true;
  }
}

/**
 * Compare two fingerprints directly without re-reading the file.
 */
export function fingerprintsMatch(a: Fingerprint, b: Fingerprint): boolean {
  return a.hash === b.hash && a.algorithm === b.algorithm;
}

/**
 * Batch fingerprint all files in a directory (recursive).
 * Returns a map keyed by relative path from the directory root.
 */
export function fingerprintDirectory(
  dirPath: string,
  options: FingerprintOptions = {}
): BatchResult {
  const fingerprints: Record<string, Fingerprint> = {};
  let totalBytes = 0;

  function walk(currentPath: string): void {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relKey = relative(dirPath, fullPath);
        const fp = fingerprint(fullPath, options);
        fingerprints[relKey] = fp;
        totalBytes += fp.size;
      }
    }
  }

  walk(dirPath);

  return {
    fingerprints,
    totalFiles: Object.keys(fingerprints).length,
    totalBytes,
    generatedAt: Date.now(),
  };
}

/**
 * Diff two BatchResults - returns lists of added, removed, and changed keys.
 */
export function diffBatch(
  previous: BatchResult,
  current: BatchResult
): { added: string[]; removed: string[]; changed: string[] } {
  const prevKeys = new Set(Object.keys(previous.fingerprints));
  const currKeys = new Set(Object.keys(current.fingerprints));

  const added = [...currKeys].filter((k) => !prevKeys.has(k));
  const removed = [...prevKeys].filter((k) => !currKeys.has(k));
  const changed = [...currKeys].filter(
    (k) =>
      prevKeys.has(k) &&
      !fingerprintsMatch(previous.fingerprints[k], current.fingerprints[k])
  );

  return { added, removed, changed };
}
