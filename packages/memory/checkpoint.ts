/**
 * Memory Checkpointing - snapshot and rollback for consolidation safety.
 * Uses SQLite VACUUM INTO for atomic snapshots.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, unlinkSync, copyFileSync } from "fs";

const MAX_CHECKPOINTS = 5;

export function checkpoint(db: Database, dataDir: string): string {
  const dir = `${dataDir}/memory-checkpoints`;
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = `${dir}/memory-${stamp}.db`;

  db.exec(`VACUUM INTO '${filePath}'`);

  // Prune old checkpoints beyond limit
  const all = listCheckpoints(dataDir);
  while (all.length > MAX_CHECKPOINTS) {
    unlinkSync(all.shift()!);
  }

  return filePath;
}

export function rollback(dbPath: string, checkpointPath: string): void {
  copyFileSync(checkpointPath, dbPath);
}

export function listCheckpoints(dataDir: string): string[] {
  const dir = `${dataDir}/memory-checkpoints`;
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("memory-") && f.endsWith(".db"))
      .sort()
      .map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
}
