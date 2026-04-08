/**
 * Backup & Restore for ~/.8gent/ user data
 *
 * Creates timestamped zip archives of config, memory, sessions, and training data.
 * Supports restore from any backup archive.
 */

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DATA_DIR = join(homedir(), ".8gent");
const BACKUP_DIR = join(DATA_DIR, "backups");

/** Directories and files to include in backup */
const BACKUP_TARGETS = [
  "config.json",
  "user.json",
  "permissions.json",
  "hooks.json",
  "cron.json",
  "tasks.json",
  "memory.db",
  "sessions",
  "training-data",
  "skills",
  "checkpoints",
  "intelligence",
  "models",
  "context",
];

export interface BackupResult {
  success: boolean;
  path: string;
  sizeBytes: number;
  itemsIncluded: string[];
  timestamp: string;
}

export interface RestoreResult {
  success: boolean;
  restoredFrom: string;
  itemsRestored: number;
  timestamp: string;
}

/** Generate a timestamped backup filename */
function backupFilename(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `8gent-backup-${ts}.zip`;
}

/** List existing targets that actually exist on disk */
async function existingTargets(): Promise<string[]> {
  const found: string[] = [];
  for (const target of BACKUP_TARGETS) {
    const full = join(DATA_DIR, target);
    if (existsSync(full)) found.push(target);
  }
  return found;
}

/**
 * Create a backup of ~/.8gent/ data as a timestamped zip.
 * Returns the path to the created archive.
 */
export async function backup(): Promise<BackupResult> {
  if (!existsSync(DATA_DIR)) {
    throw new Error(`Data directory not found: ${DATA_DIR}`);
  }

  mkdirSync(BACKUP_DIR, { recursive: true });

  const targets = await existingTargets();
  if (targets.length === 0) {
    throw new Error("No backup targets found in " + DATA_DIR);
  }

  const filename = backupFilename();
  const outPath = join(BACKUP_DIR, filename);

  // Build zip from DATA_DIR, including only known targets
  const args = targets.flatMap((t) => ["-r", t]);
  await $`cd ${DATA_DIR} && zip ${outPath} ${args}`.quiet();

  const info = await stat(outPath);

  return {
    success: true,
    path: outPath,
    sizeBytes: info.size,
    itemsIncluded: targets,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Restore ~/.8gent/ data from a backup zip.
 * Overwrites existing files. Does NOT delete files absent from the archive.
 */
export async function restore(archivePath: string): Promise<RestoreResult> {
  if (!existsSync(archivePath)) {
    throw new Error(`Backup archive not found: ${archivePath}`);
  }

  // List contents to count items
  const list = await $`unzip -l ${archivePath}`.quiet();
  const lines = list.stdout.toString().trim().split("\n");
  // unzip -l has header/footer lines; file entries are in between
  const fileCount = lines.filter((l) => /^\s+\d+/.test(l) && !l.includes("files")).length;

  await $`unzip -o ${archivePath} -d ${DATA_DIR}`.quiet();

  return {
    success: true,
    restoredFrom: basename(archivePath),
    itemsRestored: fileCount,
    timestamp: new Date().toISOString(),
  };
}

/** List all available backups, newest first */
export async function listBackups(): Promise<{ name: string; sizeBytes: number; created: Date }[]> {
  if (!existsSync(BACKUP_DIR)) return [];

  const entries = await readdir(BACKUP_DIR);
  const backups = [];

  for (const name of entries) {
    if (!name.endsWith(".zip")) continue;
    const info = await stat(join(BACKUP_DIR, name));
    backups.push({ name, sizeBytes: info.size, created: info.mtime });
  }

  return backups.sort((a, b) => b.created.getTime() - a.created.getTime());
}

// CLI entry point
if (import.meta.main) {
  const cmd = process.argv[2];

  if (cmd === "restore" && process.argv[3]) {
    const result = await restore(process.argv[3]);
    console.log(`Restored ${result.itemsRestored} items from ${result.restoredFrom}`);
  } else if (cmd === "list") {
    const list = await listBackups();
    if (list.length === 0) {
      console.log("No backups found.");
    } else {
      for (const b of list) {
        console.log(`${b.name}  ${(b.sizeBytes / 1024).toFixed(1)}KB  ${b.created.toISOString()}`);
      }
    }
  } else {
    const result = await backup();
    console.log(`Backup created: ${result.path} (${(result.sizeBytes / 1024).toFixed(1)}KB)`);
    console.log(`Included: ${result.itemsIncluded.join(", ")}`);
  }
}
