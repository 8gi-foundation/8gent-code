/**
 * Config Version Migrator
 *
 * Detects the schema version of a ~/.8gent/config.json, runs sequential
 * migrations to bring it to the current version, and writes an atomic backup
 * before touching anything.
 *
 * Exported API:
 *   getCurrentVersion(config)  - read the version string from a config object
 *   migrate(options?)          - detect, backup, migrate, write in place
 *
 * CLI:
 *   bun packages/tools/config-migrator.ts [--dry-run] [--path ~/.8gent/config.json]
 */

import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EightConfig {
  version?: string;
  [key: string]: unknown;
}

export interface MigrationResult {
  from: string;
  to: string;
  backupPath: string;
  applied: string[];
  config: EightConfig;
}

export interface MigrateOptions {
  /** Absolute path to config.json. Defaults to ~/.8gent/config.json */
  configPath?: string;
  /** If true, does not write changes to disk */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Current canonical version
// ---------------------------------------------------------------------------

export const CURRENT_VERSION = "0.4.0";

// ---------------------------------------------------------------------------
// Schema registry
//
// Each migration is a pure function: (config) => config.
// They run in order from the registered fromVersion toward CURRENT_VERSION.
// ---------------------------------------------------------------------------

interface Migration {
  fromVersion: string;
  toVersion: string;
  description: string;
  apply: (cfg: EightConfig) => EightConfig;
}

const MIGRATIONS: Migration[] = [
  {
    fromVersion: "0.1.0",
    toVersion: "0.2.0",
    description: "Add skills block with session-memory defaults",
    apply(cfg) {
      const c = { ...cfg };
      if (!c.skills || typeof c.skills !== "object") {
        c.skills = {};
      }
      const skills = c.skills as Record<string, unknown>;
      if (!skills["session-memory"]) {
        skills["session-memory"] = {
          enabled: true,
          contextTTL: "24h",
          maxEvolutionLogEntries: 1000,
        };
      }
      return { ...c, skills };
    },
  },
  {
    fromVersion: "0.2.0",
    toVersion: "0.3.0",
    description: "Add training_proxy block (disabled by default) and controlPlane block",
    apply(cfg) {
      const c = { ...cfg };
      if (!c.training_proxy) {
        c.training_proxy = {
          enabled: false,
          proxyUrl: "http://localhost:30000",
          autoStart: false,
          baseModel: "qwen2.5-coder:14b",
          configPath: "config/training-proxy.yaml",
        };
      }
      if (!c.controlPlane) {
        c.controlPlane = {
          enabled: false,
          adminDashboardPort: 3001,
          tenantId: "default",
        };
      }
      return c;
    },
  },
  {
    fromVersion: "0.3.0",
    toVersion: "0.4.0",
    description: "Add voice block; promote syncToConvex -> db.syncOnLogin",
    apply(cfg) {
      const c = { ...cfg };
      if (!c.voice) {
        c.voice = {
          enabled: false,
          mode: "local",
          model: "base",
          vadEnabled: false,
          silenceThresholdMs: 2000,
          maxRecordingMs: 30000,
        };
      }
      // Promote top-level syncToConvex into db block
      if ("syncToConvex" in c) {
        const db = (c.db ?? {}) as Record<string, unknown>;
        if (db["syncOnLogin"] === undefined) {
          db["syncOnLogin"] = c.syncToConvex;
        }
        delete c.syncToConvex;
        c.db = db;
      }
      return c;
    },
  },
];

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Return the version string from a config object. Falls back to "0.1.0". */
export function getCurrentVersion(config: EightConfig): string {
  return typeof config.version === "string" ? config.version : "0.1.0";
}

/** Compare two semver strings. Returns -1 | 0 | 1. */
function semverCompare(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff < 0) return -1;
    if (diff > 0) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

async function backupConfig(configPath: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.backup-${ts}`;
  const raw = await Bun.file(configPath).text();
  await Bun.write(backupPath, raw);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Core migrate()
// ---------------------------------------------------------------------------

/**
 * Detect config version, back up, apply all pending migrations in order,
 * write the updated config back in place.
 */
export async function migrate(options: MigrateOptions = {}): Promise<MigrationResult> {
  const configPath =
    options.configPath ?? join(homedir(), ".8gent", "config.json");

  const raw = await Bun.file(configPath).text();
  let config: EightConfig = JSON.parse(raw);
  const from = getCurrentVersion(config);

  // Already up to date
  if (semverCompare(from, CURRENT_VERSION) >= 0) {
    return { from, to: from, backupPath: "", applied: [], config };
  }

  // Backup before touching anything
  const backupPath = options.dryRun
    ? "(dry-run - no backup written)"
    : await backupConfig(configPath);

  // Run applicable migrations in order
  const pending = MIGRATIONS.filter(
    (m) =>
      semverCompare(m.fromVersion, from) >= 0 &&
      semverCompare(m.fromVersion, CURRENT_VERSION) < 0,
  ).sort((a, b) => semverCompare(a.fromVersion, b.fromVersion));

  const applied: string[] = [];
  for (const m of pending) {
    if (semverCompare(getCurrentVersion(config), m.fromVersion) <= 0) {
      config = m.apply(config);
      config.version = m.toVersion;
      applied.push(`${m.fromVersion} -> ${m.toVersion}: ${m.description}`);
    }
  }

  config.version = CURRENT_VERSION;

  if (!options.dryRun) {
    await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  return { from, to: CURRENT_VERSION, backupPath, applied, config };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const pathIndex = args.indexOf("--path");
  const configPath =
    pathIndex !== -1 && args[pathIndex + 1] ? args[pathIndex + 1] : undefined;

  console.log("8gent config migrator");
  console.log(`  target version : ${CURRENT_VERSION}`);
  if (dryRun) console.log("  mode           : dry-run (no writes)");

  try {
    const result = await migrate({ configPath, dryRun });

    if (result.applied.length === 0) {
      console.log(`  status         : already at ${result.from}, nothing to do`);
    } else {
      console.log(`  migrated       : ${result.from} -> ${result.to}`);
      if (!dryRun) console.log(`  backup         : ${result.backupPath}`);
      console.log("  migrations applied:");
      for (const step of result.applied) {
        console.log(`    - ${step}`);
      }
    }
  } catch (err) {
    console.error("migration failed:", (err as Error).message);
    process.exit(1);
  }
}
