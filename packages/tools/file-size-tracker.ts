/**
 * file-size-tracker - tracks file sizes over time to detect bloat
 * Quarantine status: not wired into agent tools yet
 */

import { statSync, readdirSync } from "fs";
import { join, relative } from "path";

export interface FileSizeEntry {
  path: string;
  bytes: number;
  recordedAt: number;
}

export interface SizeBaseline {
  dir: string;
  files: Record<string, FileSizeEntry>;
  totalBytes: number;
  recordedAt: number;
}

export interface SizeDelta {
  path: string;
  baselineBytes: number;
  currentBytes: number;
  deltaBytes: number;
  deltaPercent: number;
  flag: "growth" | "shrinkage" | "new" | "removed" | "unchanged";
}

export interface SizeReport {
  dir: string;
  generatedAt: number;
  totalBaselineBytes: number;
  totalCurrentBytes: number;
  totalDeltaBytes: number;
  flagged: SizeDelta[];
  all: SizeDelta[];
  summary: string;
}

export interface TrackOptions {
  /** File extensions to include. Empty array = all files. Default: [] */
  extensions?: string[];
  /** Directories to skip. Default: ["node_modules", ".git", "dist"] */
  skip?: string[];
}

const DEFAULT_SKIP = ["node_modules", ".git", "dist", ".next", "build"];

function walkDir(
  dirPath: string,
  options: Required<TrackOptions>
): FileSizeEntry[] {
  const results: FileSizeEntry[] = [];

  function walk(current: string): void {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (options.skip.includes(entry.name)) continue;

      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        if (
          options.extensions.length > 0 &&
          !options.extensions.some((ext) => entry.name.endsWith(ext))
        ) {
          continue;
        }

        try {
          const stat = statSync(fullPath);
          results.push({
            path: relative(dirPath, fullPath),
            bytes: stat.size,
            recordedAt: Date.now(),
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dirPath);
  return results;
}

/**
 * Scan a directory and record current file sizes as a baseline snapshot.
 */
export function trackSizes(
  dir: string,
  options: TrackOptions = {}
): SizeBaseline {
  const opts: Required<TrackOptions> = {
    extensions: options.extensions ?? [],
    skip: options.skip ?? DEFAULT_SKIP,
  };

  const entries = walkDir(dir, opts);
  const files: Record<string, FileSizeEntry> = {};
  let totalBytes = 0;

  for (const entry of entries) {
    files[entry.path] = entry;
    totalBytes += entry.bytes;
  }

  return { dir, files, totalBytes, recordedAt: Date.now() };
}

/**
 * Compare current directory sizes against a previously recorded baseline.
 * Returns deltas for every file observed in either snapshot.
 *
 * @param thresholdBytes - Flag growth beyond this many bytes. Default: 10_000 (10 KB)
 */
export function compareBaseline(
  dir: string,
  baseline: SizeBaseline,
  options: TrackOptions & { thresholdBytes?: number } = {}
): SizeDelta[] {
  const threshold = options.thresholdBytes ?? 10_000;
  const current = trackSizes(dir, options);
  const deltas: SizeDelta[] = [];

  const allPaths = new Set([
    ...Object.keys(baseline.files),
    ...Object.keys(current.files),
  ]);

  for (const path of allPaths) {
    const baseEntry = baseline.files[path];
    const currEntry = current.files[path];

    const baseBytes = baseEntry?.bytes ?? 0;
    const currBytes = currEntry?.bytes ?? 0;
    const deltaBytes = currBytes - baseBytes;
    const deltaPercent = baseBytes === 0 ? 100 : (deltaBytes / baseBytes) * 100;

    let flag: SizeDelta["flag"] = "unchanged";
    if (!baseEntry) flag = "new";
    else if (!currEntry) flag = "removed";
    else if (deltaBytes > threshold) flag = "growth";
    else if (deltaBytes < 0) flag = "shrinkage";

    deltas.push({ path, baselineBytes: baseBytes, currentBytes: currBytes, deltaBytes, deltaPercent, flag });
  }

  return deltas.sort((a, b) => Math.abs(b.deltaBytes) - Math.abs(a.deltaBytes));
}

/**
 * Generate a human-readable report from a set of size deltas.
 */
export function generateReport(
  dir: string,
  deltas: SizeDelta[],
  baseline: SizeBaseline
): SizeReport {
  const totalCurrentBytes = deltas.reduce((sum, d) => sum + d.currentBytes, 0);
  const totalDeltaBytes = totalCurrentBytes - baseline.totalBytes;
  const flagged = deltas.filter((d) => d.flag === "growth" || d.flag === "new");

  const lines: string[] = [
    `File Size Report — ${dir}`,
    `Baseline: ${(baseline.totalBytes / 1024).toFixed(1)} KB  Current: ${(totalCurrentBytes / 1024).toFixed(1)} KB  Delta: ${totalDeltaBytes >= 0 ? "+" : ""}${(totalDeltaBytes / 1024).toFixed(1)} KB`,
    flagged.length > 0 ? `Flagged (${flagged.length}):` : "No files flagged.",
    ...flagged.map(
      (d) =>
        `  [${d.flag.toUpperCase()}] ${d.path}  +${(d.deltaBytes / 1024).toFixed(1)} KB (${d.deltaPercent.toFixed(0)}%)`
    ),
  ];

  return {
    dir,
    generatedAt: Date.now(),
    totalBaselineBytes: baseline.totalBytes,
    totalCurrentBytes,
    totalDeltaBytes,
    flagged,
    all: deltas,
    summary: lines.join("\n"),
  };
}
