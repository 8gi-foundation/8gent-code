/**
 * 8gent Database Migration System
 *
 * Reads migration files from ~/.8gent/migrations/, tracks applied versions
 * in a _migrations table, and runs up/down for SQLite schema changes.
 *
 * Migration files are named: {version}_{description}.sql
 * Example: 001_add_memories_table.sql
 *
 * Each file contains two sections separated by "-- DOWN":
 *   CREATE TABLE foo (...);
 *   -- DOWN
 *   DROP TABLE foo;
 */

import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface Migration {
  version: string;
  description: string;
  upSQL: string;
  downSQL: string;
  filename: string;
}

export interface AppliedMigration {
  version: string;
  applied_at: string;
  filename: string;
}

const MIGRATIONS_DIR = join(homedir(), ".8gent", "migrations");

const TRACKER_SCHEMA = `
CREATE TABLE IF NOT EXISTS _migrations (
  version TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;

/** Parse a migration file into up/down SQL blocks */
function parseMigrationFile(filename: string, content: string): Migration {
  const match = filename.match(/^(\d+)_(.+)\.sql$/);
  if (!match) {
    throw new Error(`Invalid migration filename: ${filename} - expected {version}_{description}.sql`);
  }

  const [, version, description] = match;
  const separator = "-- DOWN";
  const sepIndex = content.indexOf(separator);

  const upSQL = sepIndex >= 0 ? content.slice(0, sepIndex).trim() : content.trim();
  const downSQL = sepIndex >= 0 ? content.slice(sepIndex + separator.length).trim() : "";

  return { version, description: description.replace(/_/g, " "), upSQL, downSQL, filename };
}

/** Load all migration files from the migrations directory, sorted by version */
async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // No migrations directory yet
  }

  const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();
  const migrations: Migration[] = [];

  for (const file of sqlFiles) {
    const content = await readFile(join(dir, file), "utf-8");
    migrations.push(parseMigrationFile(file, content));
  }

  return migrations;
}

/** Ensure the _migrations tracking table exists */
function ensureTracker(db: Database): void {
  db.exec(TRACKER_SCHEMA);
}

/** Get all applied migration versions */
export function getApplied(db: Database): AppliedMigration[] {
  ensureTracker(db);
  return db.query("SELECT version, applied_at, filename FROM _migrations ORDER BY version").all() as AppliedMigration[];
}

/** Get pending migrations that have not been applied */
export async function getPending(db: Database, dir?: string): Promise<Migration[]> {
  const all = await loadMigrations(dir);
  const applied = new Set(getApplied(db).map((m) => m.version));
  return all.filter((m) => !applied.has(m.version));
}

/** Run all pending migrations (up). Returns count of applied migrations. */
export async function migrateUp(db: Database, dir?: string): Promise<number> {
  ensureTracker(db);
  const pending = await getPending(db, dir);

  for (const migration of pending) {
    if (!migration.upSQL) continue;
    db.transaction(() => {
      db.exec(migration.upSQL);
      db.prepare("INSERT INTO _migrations (version, filename) VALUES (?, ?)").run(
        migration.version,
        migration.filename
      );
    })();
  }

  return pending.length;
}

/** Roll back the most recent N migrations (down). Returns count of reverted. */
export async function migrateDown(db: Database, count: number = 1, dir?: string): Promise<number> {
  ensureTracker(db);
  const all = await loadMigrations(dir);
  const applied = getApplied(db);
  const toRevert = applied.slice(-count).reverse();
  let reverted = 0;

  for (const record of toRevert) {
    const migration = all.find((m) => m.version === record.version);
    if (!migration?.downSQL) {
      throw new Error(`No down SQL for migration ${record.version} (${record.filename})`);
    }
    db.transaction(() => {
      db.exec(migration.downSQL);
      db.prepare("DELETE FROM _migrations WHERE version = ?").run(record.version);
    })();
    reverted++;
  }

  return reverted;
}

/** Get migration status summary */
export async function status(db: Database, dir?: string): Promise<{ applied: number; pending: number; latest: string | null }> {
  const applied = getApplied(db);
  const pending = await getPending(db, dir);
  return {
    applied: applied.length,
    pending: pending.length,
    latest: applied.length > 0 ? applied[applied.length - 1].version : null,
  };
}
