/**
 * fs-utils: Common filesystem operations simplified.
 *
 * All functions are async and throw on unrecoverable errors.
 * Use these instead of raw fs calls to avoid boilerplate.
 */

import fs from "fs";
import path from "path";
import os from "os";

/**
 * Ensures a directory exists, creating it (and any parents) if needed.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

/**
 * Ensures a file exists. Creates the file (and parent dirs) if missing.
 * Does not overwrite existing content.
 */
export async function ensureFile(filePath: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  try {
    const fd = await fs.promises.open(filePath, "ax");
    await fd.close();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * Reads and parses a JSON file. Returns the parsed value.
 */
export async function readJSON<T = unknown>(filePath: string): Promise<T> {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Serialises data to JSON and writes it to filePath.
 * Parent directories are created if missing.
 */
export async function writeJSON(
  filePath: string,
  data: unknown,
  indent = 2,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, indent) + "\n", "utf-8");
}

/**
 * Recursively copies a directory from src to dest.
 * dest is created if it does not exist.
 */
export async function copyDir(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyDir(srcPath, destPath);
      } else {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }),
  );
}

/**
 * Moves a file from src to dest.
 * Attempts atomic rename first; falls back to copy+delete across devices.
 */
export async function moveFile(src: string, dest: string): Promise<void> {
  await ensureDir(path.dirname(dest));
  try {
    await fs.promises.rename(src, dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.promises.copyFile(src, dest);
    await fs.promises.unlink(src);
  }
}

/**
 * Creates a temporary file and returns its path.
 * Caller is responsible for cleanup.
 */
export async function tempFile(prefix = "8gent-"): Promise<string> {
  const dir = os.tmpdir();
  const name = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const filePath = path.join(dir, name);
  await fs.promises.writeFile(filePath, "");
  return filePath;
}

/**
 * Creates a temporary directory and returns its path.
 * Caller is responsible for cleanup.
 */
export async function tempDir(prefix = "8gent-"): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Returns the size of a single file in bytes.
 */
export async function fileSize(filePath: string): Promise<number> {
  const stat = await fs.promises.stat(filePath);
  return stat.size;
}

/**
 * Returns the total size (in bytes) of all files in a directory, recursively.
 */
export async function dirSize(dirPath: string): Promise<number> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) return dirSize(entryPath);
      const stat = await fs.promises.stat(entryPath);
      return stat.size;
    }),
  );
  return sizes.reduce((sum, s) => sum + s, 0);
}
