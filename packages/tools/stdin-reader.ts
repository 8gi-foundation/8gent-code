/**
 * stdin-reader.ts
 * Reads piped stdin with automatic format detection and streaming line-by-line processing.
 *
 * Exports:
 *   readStdin(options?)  - read all stdin, detect format, return parsed result
 *   detectFormat(input)  - classify raw string as JSON | CSV | NDJSON | text
 *   isInteractive()      - returns true if process is attached to a TTY (no pipe)
 */

import * as readline from "readline";

export type StdinFormat = "json" | "csv" | "ndjson" | "text";

export interface StdinOptions {
  /** Max bytes to buffer. Default: 10 MB. */
  maxBytes?: number;
  /** Encoding. Default: utf-8. */
  encoding?: BufferEncoding;
  /** If true, return raw string even when format is json/ndjson. Default: false. */
  rawOnly?: boolean;
}

export interface StdinResult {
  format: StdinFormat;
  raw: string;
  lines: string[];
  parsed: unknown;
}

/** Returns true when stdin is a TTY (interactive terminal, no pipe). */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Heuristically classify a raw string.
 * Priority: JSON > NDJSON > CSV > text
 */
export function detectFormat(input: string): StdinFormat {
  const trimmed = input.trim();

  if (!trimmed) return "text";

  // JSON: starts with { or [
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // fall through
    }
  }

  // NDJSON: every non-empty line is valid JSON
  const nonEmpty = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (nonEmpty.length > 0) {
    const allJson = nonEmpty.every((line) => {
      const l = line.trim();
      if (!l.startsWith("{") && !l.startsWith("[")) return false;
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    if (allJson) return "ndjson";
  }

  // CSV: first line has commas, subsequent lines have same field count
  const lines = trimmed.split("\n");
  if (lines.length >= 2) {
    const headerFields = lines[0].split(",").length;
    if (headerFields > 1) {
      const csvLike = lines.every((l) => l.split(",").length === headerFields);
      if (csvLike) return "csv";
    }
  }

  return "text";
}

/** Parse CSV into array of objects using first row as headers. */
function parseCsv(input: string): Record<string, string>[] {
  const lines = input.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] ?? "").trim();
    });
    return row;
  });
}

/**
 * Read all of stdin, detect format, parse, and return result.
 * Rejects if stdin is interactive (no pipe) unless rawOnly is set.
 * Streams line-by-line internally to respect backpressure.
 */
export async function readStdin(options: StdinOptions = {}): Promise<StdinResult> {
  const { maxBytes = 10 * 1024 * 1024, encoding = "utf-8", rawOnly = false } = options;

  if (isInteractive()) {
    throw new Error("stdin is a TTY - pipe data into this process");
  }

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let totalBytes = 0;

    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });

    const collectedLines: string[] = [];

    rl.on("line", (line) => {
      const byteLen = Buffer.byteLength(line, encoding) + 1; // +1 for newline
      totalBytes += byteLen;
      if (totalBytes > maxBytes) {
        rl.close();
        reject(new Error(`stdin exceeded maxBytes limit (${maxBytes})`));
        return;
      }
      collectedLines.push(line);
      chunks.push(line);
    });

    rl.on("close", () => {
      const raw = collectedLines.join("\n");
      const format = detectFormat(raw);

      let parsed: unknown = raw;

      if (!rawOnly) {
        switch (format) {
          case "json":
            try { parsed = JSON.parse(raw); } catch { parsed = raw; }
            break;
          case "ndjson":
            parsed = collectedLines
              .filter((l) => l.trim().length > 0)
              .map((l) => { try { return JSON.parse(l); } catch { return l; } });
            break;
          case "csv":
            parsed = parseCsv(raw);
            break;
          default:
            parsed = raw;
        }
      }

      resolve({ format, raw, lines: collectedLines, parsed });
    });

    rl.on("error", reject);
  });
}
