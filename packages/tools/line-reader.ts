/**
 * line-reader.ts - Efficient line-by-line file reading utilities.
 *
 * Provides async and sync generators for streaming large files without
 * loading them entirely into memory, plus head/tail/grep/count helpers.
 */

import { createReadStream } from "fs";
import { readFileSync } from "fs";
import { createInterface } from "readline";

// ---------------------------------------------------------------------------
// Async generator - streams file via readline, no full-file load
// ---------------------------------------------------------------------------

/**
 * Async generator that yields each line of a file in order.
 * Memory-efficient: buffers only one chunk at a time.
 *
 * @example
 * for await (const line of readLines("/path/to/file.ts")) {
 *   console.log(line);
 * }
 */
export async function* readLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    yield line;
  }
}

// ---------------------------------------------------------------------------
// Sync generator - reads entire file then yields lines one by one.
// For small-to-medium files where async overhead is unwanted.
// ---------------------------------------------------------------------------

/**
 * Sync generator that yields each line of a file.
 * Reads the full file once into memory - use readLines() for large files.
 *
 * @example
 * for (const line of readLinesSync("/path/to/file.ts")) {
 *   console.log(line);
 * }
 */
export function* readLinesSync(path: string): Generator<string> {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  // Drop trailing empty string caused by final newline
  const last = lines.length - 1;
  for (let i = 0; i <= last; i++) {
    if (i === last && lines[i] === "") break;
    yield lines[i];
  }
}

// ---------------------------------------------------------------------------
// countLines - fast line count without loading all content at once
// ---------------------------------------------------------------------------

/**
 * Counts total lines in a file using streaming. Does not load full content.
 */
export async function countLines(path: string): Promise<number> {
  let count = 0;
  for await (const _ of readLines(path)) count++;
  return count;
}

// ---------------------------------------------------------------------------
// headLines - first N lines
// ---------------------------------------------------------------------------

/**
 * Returns the first n lines of a file as an array.
 * Stops reading after n lines - does not scan the whole file.
 */
export async function headLines(path: string, n: number): Promise<string[]> {
  const results: string[] = [];
  for await (const line of readLines(path)) {
    results.push(line);
    if (results.length >= n) break;
  }
  return results;
}

// ---------------------------------------------------------------------------
// tailLines - last N lines via circular buffer
// ---------------------------------------------------------------------------

/**
 * Returns the last n lines of a file as an array.
 * Uses a fixed-size circular buffer - O(n) memory regardless of file size.
 */
export async function tailLines(path: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const buf: string[] = new Array(n);
  let pos = 0;
  let total = 0;
  for await (const line of readLines(path)) {
    buf[pos % n] = line;
    pos++;
    total++;
  }
  if (total === 0) return [];
  if (total <= n) {
    return buf.slice(0, total);
  }
  // Circular: oldest entry sits at pos % n
  const start = pos % n;
  return [...buf.slice(start), ...buf.slice(0, start)];
}

// ---------------------------------------------------------------------------
// grepLines - filter lines by pattern, return matches with line numbers
// ---------------------------------------------------------------------------

export interface GrepMatch {
  lineNumber: number; // 1-based
  line: string;
}

/**
 * Streams a file and returns all lines matching pattern.
 * Line numbers are 1-based.
 *
 * @example
 * const hits = await grepLines("./src/app.ts", /TODO/i);
 */
export async function grepLines(
  path: string,
  pattern: string | RegExp
): Promise<GrepMatch[]> {
  const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  const matches: GrepMatch[] = [];
  let lineNumber = 0;
  for await (const line of readLines(path)) {
    lineNumber++;
    if (re.test(line)) matches.push({ lineNumber, line });
  }
  return matches;
}
