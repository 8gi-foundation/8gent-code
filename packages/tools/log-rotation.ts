/**
 * Log Rotation Tool
 *
 * Rotates log files in ~/.8gent/ when they exceed a size limit.
 * Keeps the last N rotated files and compresses older ones with gzip.
 */

import { readdir, stat, rename, unlink } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { gzipSync } from "node:zlib";

export interface LogRotationConfig {
  /** Directory containing log files. Defaults to ~/.8gent/ */
  logDir?: string;
  /** Max file size in bytes before rotation. Defaults to 5MB */
  maxSizeBytes?: number;
  /** Number of rotated files to keep (uncompressed + compressed). Defaults to 5 */
  keepCount?: number;
  /** Glob pattern for log files. Defaults to .log extension */
  extension?: string;
}

const DEFAULT_CONFIG: Required<LogRotationConfig> = {
  logDir: join(homedir(), ".8gent"),
  maxSizeBytes: 5 * 1024 * 1024,
  keepCount: 5,
  extension: ".log",
};

/** Rotate a single log file: rename current, compress old, prune excess */
async function rotateFile(
  filePath: string,
  keepCount: number,
): Promise<{ rotated: boolean; pruned: number }> {
  const dir = join(filePath, "..");
  const name = basename(filePath, extname(filePath));
  const ext = extname(filePath);

  // Collect existing rotated files (e.g. app.1.log, app.2.log.gz)
  const entries = await readdir(dir);
  const rotatedPattern = new RegExp(
    `^${escapeRegex(name)}\\.(\\d+)${escapeRegex(ext)}(\\.gz)?$`,
  );
  const rotated = entries
    .map((e) => {
      const m = e.match(rotatedPattern);
      return m ? { file: e, index: parseInt(m[1], 10), gz: !!m[2] } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b!.index - a!.index) as { file: string; index: number; gz: boolean }[];

  // Shift existing rotated files up by one index
  for (const r of rotated) {
    const newIndex = r.index + 1;
    if (newIndex > keepCount) {
      await unlink(join(dir, r.file));
      continue;
    }
    const newName = `${name}.${newIndex}${ext}${r.gz ? ".gz" : ""}`;
    await rename(join(dir, r.file), join(dir, newName));
  }

  // Rename current file to .1
  const rotatedPath = join(dir, `${name}.1${ext}`);
  await rename(filePath, rotatedPath);

  // Compress any uncompressed rotated files with index >= 2
  const freshEntries = await readdir(dir);
  for (const e of freshEntries) {
    const m = e.match(rotatedPattern);
    if (m && parseInt(m[1], 10) >= 2 && !m[2]) {
      const full = join(dir, e);
      const raw = await Bun.file(full).arrayBuffer();
      await Bun.write(`${full}.gz`, gzipSync(Buffer.from(raw)));
      await unlink(full);
    }
  }

  // Count pruned
  const pruned = rotated.filter((r) => r.index + 1 > keepCount).length;
  return { rotated: true, pruned };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scan logDir and rotate any files exceeding maxSizeBytes */
export async function rotateLogs(
  config: LogRotationConfig = {},
): Promise<{ scanned: number; rotated: string[]; errors: string[] }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const entries = await readdir(cfg.logDir);
  const logFiles = entries.filter(
    (e) => e.endsWith(cfg.extension) && !e.match(/\.\d+\.log/),
  );

  const rotated: string[] = [];
  const errors: string[] = [];

  for (const file of logFiles) {
    const fullPath = join(cfg.logDir, file);
    try {
      const info = await stat(fullPath);
      if (!info.isFile() || info.size <= cfg.maxSizeBytes) continue;
      await rotateFile(fullPath, cfg.keepCount);
      rotated.push(file);
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }

  return { scanned: logFiles.length, rotated, errors };
}
