/**
 * JSON Lines (JSONL) format reader, writer, appender, and utilities.
 * Handles newline-delimited JSON files with streaming support.
 * Spec: https://jsonlines.org
 */

import { createReadStream, createWriteStream } from "fs";
import { open, stat } from "fs/promises";
import { createInterface } from "readline";

/**
 * Async generator that yields parsed objects from a JSONL file, one per line.
 * Skips blank lines and lines that fail JSON.parse.
 */
export async function* readLines<T = unknown>(path: string): AsyncGenerator<T> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      // skip malformed lines
    }
  }
}

/**
 * Writes an array of items to a JSONL file, overwriting any existing content.
 * Each item is serialized as a single JSON line.
 */
export async function writeLines<T = unknown>(
  path: string,
  items: T[]
): Promise<void> {
  const ws = createWriteStream(path, { encoding: "utf8", flags: "w" });
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("finish", resolve);
    for (const item of items) {
      ws.write(JSON.stringify(item) + "\n");
    }
    ws.end();
  });
}

/**
 * Appends a single item as a new JSON line to the file.
 * Creates the file if it does not exist.
 */
export async function appendLine<T = unknown>(
  path: string,
  item: T
): Promise<void> {
  const fd = await open(path, "a");
  try {
    await fd.write(JSON.stringify(item) + "\n");
  } finally {
    await fd.close();
  }
}

/**
 * Counts the number of non-empty, valid JSON lines in a file.
 */
export async function countLines(path: string): Promise<number> {
  let count = 0;
  for await (const _item of readLines(path)) {
    count++;
  }
  return count;
}

/**
 * Returns the last n valid JSON lines from the file as parsed objects.
 * Reads the entire file but only keeps a sliding window of size n.
 */
export async function tailLines<T = unknown>(
  path: string,
  n: number
): Promise<T[]> {
  if (n <= 0) return [];
  const buffer: T[] = [];
  for await (const item of readLines<T>(path)) {
    buffer.push(item);
    if (buffer.length > n) buffer.shift();
  }
  return buffer;
}

/**
 * Async generator that yields only lines where predicate returns true.
 * Useful for streaming large files without loading them into memory.
 */
export async function* filterLines<T = unknown>(
  path: string,
  predicate: (item: T) => boolean
): AsyncGenerator<T> {
  for await (const item of readLines<T>(path)) {
    if (predicate(item)) yield item;
  }
}

/**
 * Returns the byte size of the file, or 0 if it does not exist.
 */
export async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return 0;
  }
}
