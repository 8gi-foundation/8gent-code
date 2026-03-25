/**
 * content-hash-v2 - Content-addressable hashing for build caching.
 *
 * Provides deterministic hashing of file content and directory trees,
 * manifest generation, and manifest diffing for incremental build pipelines.
 */

import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export type HashAlgo = "sha256" | "sha1" | "md5";
export type HashManifest = Record<string, string>;

export interface ManifestDiff {
  changed: string[];
  added: string[];
  removed: string[];
}

const DEFAULT_ALGO: HashAlgo = "sha256";

const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  ".8gent",
  "dist",
  ".cache",
  "*.log",
];

/**
 * Hash arbitrary content (string or Buffer).
 */
export function contentHash(
  content: string | Buffer,
  algo: HashAlgo = DEFAULT_ALGO
): string {
  return createHash(algo).update(content).digest("hex");
}

/**
 * Hash the content of a single file on disk.
 */
export function fileContentHash(
  filePath: string,
  algo: HashAlgo = DEFAULT_ALGO
): string {
  const buf = readFileSync(filePath);
  return contentHash(buf, algo);
}

/**
 * Recursively collect all file paths under a directory,
 * excluding entries that match the ignore list.
 */
function collectFiles(dir: string, ignore: string[]): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = readdirSync(current);
    for (const entry of entries) {
      if (shouldIgnore(entry, ignore)) continue;
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results.sort(); // deterministic ordering
}

function shouldIgnore(name: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p.startsWith("*")) {
      return name.endsWith(p.slice(1));
    }
    return name === p;
  });
}

/**
 * Hash an entire directory tree into a single hash.
 * Combines all file hashes in sorted path order for determinism.
 */
export function directoryHash(
  dir: string,
  ignore: string[] = DEFAULT_IGNORE,
  algo: HashAlgo = DEFAULT_ALGO
): string {
  const files = collectFiles(dir, ignore);
  const combined = createHash(algo);
  for (const file of files) {
    const rel = relative(dir, file);
    const fileHash = fileContentHash(file, algo);
    combined.update(`${rel}:${fileHash}\n`);
  }
  return combined.digest("hex");
}

/**
 * Generate a manifest mapping relative file paths to their content hashes.
 * Suitable for storing as a build artifact and comparing across builds.
 */
export function hashManifest(
  dir: string,
  ignore: string[] = DEFAULT_IGNORE,
  algo: HashAlgo = DEFAULT_ALGO
): HashManifest {
  const files = collectFiles(dir, ignore);
  const manifest: HashManifest = {};
  for (const file of files) {
    const rel = relative(dir, file);
    manifest[rel] = fileContentHash(file, algo);
  }
  return manifest;
}

/**
 * Diff two manifests and return which paths changed, were added, or were removed.
 * Useful for incremental build invalidation - only rebuild what changed.
 */
export function diffManifests(
  prev: HashManifest,
  next: HashManifest
): ManifestDiff {
  const prevKeys = new Set(Object.keys(prev));
  const nextKeys = new Set(Object.keys(next));

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const key of nextKeys) {
    if (!prevKeys.has(key)) {
      added.push(key);
    } else if (prev[key] !== next[key]) {
      changed.push(key);
    }
  }

  for (const key of prevKeys) {
    if (!nextKeys.has(key)) {
      removed.push(key);
    }
  }

  return {
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
  };
}
