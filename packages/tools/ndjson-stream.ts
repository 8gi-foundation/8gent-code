/**
 * ndjson-stream - Newline-delimited JSON stream reader/writer
 *
 * Provides async generators for parsing NDJSON streams and utilities
 * for reading, writing, and appending NDJSON files.
 */

import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

// ---------------------------------------------------------------------------
// Core stream parser
// ---------------------------------------------------------------------------

/**
 * Parse an NDJSON string or Buffer input, yielding one parsed object per line.
 * Blank lines and lines that fail to parse are skipped.
 */
export async function* parseNDJSON<T = unknown>(
  input: string | Buffer | Readable
): AsyncGenerator<T> {
  let source: Readable;

  if (input instanceof Readable) {
    source = input;
  } else {
    const text = Buffer.isBuffer(input) ? input.toString("utf8") : input;
    source = Readable.from([text]);
  }

  const rl = createInterface({ input: source, crlfDelay: Infinity });

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

// ---------------------------------------------------------------------------
// Core stringifier
// ---------------------------------------------------------------------------

/**
 * Convert an array (or async iterable) of objects to an NDJSON string.
 * Each object is serialized on its own line; trailing newline included.
 */
export async function stringifyNDJSON<T>(
  items: Iterable<T> | AsyncIterable<T>
): Promise<string> {
  const lines: string[] = [];

  if (Symbol.asyncIterator in Object(items)) {
    for await (const item of items as AsyncIterable<T>) {
      lines.push(JSON.stringify(item));
    }
  } else {
    for (const item of items as Iterable<T>) {
      lines.push(JSON.stringify(item));
    }
  }

  return lines.length ? lines.join("\n") + "\n" : "";
}

// ---------------------------------------------------------------------------
// File reader
// ---------------------------------------------------------------------------

/**
 * Lazily read an NDJSON file line-by-line, yielding each parsed object.
 * Streams the file - memory-safe for large files.
 */
export async function* readNDJSONFile<T = unknown>(
  filePath: string
): AsyncGenerator<T> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  yield* parseNDJSON<T>(stream);
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

/**
 * Write an array (or async iterable) of objects to a file as NDJSON.
 * Overwrites the file if it already exists.
 */
export async function writeNDJSONFile<T>(
  filePath: string,
  items: Iterable<T> | AsyncIterable<T>
): Promise<void> {
  const ndjson = await stringifyNDJSON(items);
  await fs.writeFile(filePath, ndjson, "utf8");
}

// ---------------------------------------------------------------------------
// Append helper
// ---------------------------------------------------------------------------

/**
 * Append a single object as one NDJSON line to a file.
 * Creates the file if it does not exist. Adds a trailing newline.
 */
export async function appendNDJSON<T>(
  filePath: string,
  item: T
): Promise<void> {
  const line = JSON.stringify(item) + "\n";
  await fs.appendFile(filePath, line, "utf8");
}
