import { createHash } from "crypto";
import { createReadStream } from "fs";
import { readdir, stat } from "fs/promises";
import { join, relative } from "path";

export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512";

export interface DirectoryHashOptions {
  algorithm?: HashAlgorithm;
  ignore?: string[];
  recursive?: boolean;
}

export interface DirectoryHashResult {
  combined: string;
  files: Record<string, string>;
}

/**
 * Hash a file using streaming - handles arbitrarily large files without loading
 * them into memory.
 */
export function hashFile(
  filePath: string,
  algorithm: HashAlgorithm = "sha256"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Hash all files in a directory. Returns per-file hashes and a combined
 * deterministic hash of the whole tree.
 */
export async function hashDirectory(
  dir: string,
  options: DirectoryHashOptions = {}
): Promise<DirectoryHashResult> {
  const {
    algorithm = "sha256",
    ignore = [],
    recursive = true,
  } = options;

  const ignoreSet = new Set(ignore);
  const files: Record<string, string> = {};

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue;

      const fullPath = join(current, entry.name);
      const relPath = relative(dir, fullPath);

      if (entry.isDirectory()) {
        if (recursive) await walk(fullPath);
      } else if (entry.isFile()) {
        files[relPath] = await hashFile(fullPath, algorithm);
      }
    }
  }

  await walk(dir);

  // Build a deterministic combined hash from sorted file paths + their hashes
  const combined = createHash(algorithm);
  for (const key of Object.keys(files).sort()) {
    combined.update(`${key}:${files[key]}\n`);
  }

  return { combined: combined.digest("hex"), files };
}

/**
 * Compare the hashes of two paths (files or directories).
 * Returns true if the content is identical.
 */
export async function compareHashes(
  pathA: string,
  pathB: string,
  algorithm: HashAlgorithm = "sha256"
): Promise<boolean> {
  const [statA, statB] = await Promise.all([stat(pathA), stat(pathB)]);

  if (statA.isDirectory() !== statB.isDirectory()) return false;

  if (statA.isDirectory()) {
    const [a, b] = await Promise.all([
      hashDirectory(pathA, { algorithm }),
      hashDirectory(pathB, { algorithm }),
    ]);
    return a.combined === b.combined;
  }

  const [a, b] = await Promise.all([
    hashFile(pathA, algorithm),
    hashFile(pathB, algorithm),
  ]);
  return a === b;
}

/**
 * Verify a file against a known expected hash. Throws if path does not exist.
 * Returns true on match, false on mismatch.
 */
export async function verifyHash(
  filePath: string,
  expected: string,
  algorithm: HashAlgorithm = "sha256"
): Promise<boolean> {
  const actual = await hashFile(filePath, algorithm);
  return actual.toLowerCase() === expected.toLowerCase();
}
