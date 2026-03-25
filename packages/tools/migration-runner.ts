import { readFileSync, writeFileSync, existsSync } from "fs";

export interface Migration {
  version: string;
  description?: string;
  up: () => Promise<void> | void;
  down?: () => Promise<void> | void;
}

interface MigrationRecord {
  version: string;
  appliedAt: string;
  description?: string;
}

interface MigrationState {
  applied: MigrationRecord[];
}

export class MigrationRunner {
  private migrations: Migration[] = [];
  private stateFile: string;

  constructor(stateFile = ".8gent/migrations.json") {
    this.stateFile = stateFile;
  }

  register(
    version: string,
    up: () => Promise<void> | void,
    down?: () => Promise<void> | void,
    description?: string
  ): this {
    if (this.migrations.find((m) => m.version === version)) {
      throw new Error(`Migration version ${version} already registered`);
    }
    this.migrations.push({ version, up, down, description });
    // Keep sorted by version string
    this.migrations.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    return this;
  }

  private loadState(): MigrationState {
    if (!existsSync(this.stateFile)) return { applied: [] };
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf-8"));
    } catch {
      return { applied: [] };
    }
  }

  private saveState(state: MigrationState): void {
    const dir = this.stateFile.split("/").slice(0, -1).join("/");
    if (dir && !existsSync(dir)) {
      const { mkdirSync } = require("fs");
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  current(): string | null {
    const state = this.loadState();
    const applied = state.applied;
    if (applied.length === 0) return null;
    return applied[applied.length - 1].version;
  }

  pending(targetVersion?: string): Migration[] {
    const state = this.loadState();
    const appliedVersions = new Set(state.applied.map((r) => r.version));
    const pending = this.migrations.filter((m) => !appliedVersions.has(m.version));
    if (!targetVersion) return pending;
    return pending.filter((m) => m.version.localeCompare(targetVersion, undefined, { numeric: true }) <= 0);
  }

  history(): MigrationRecord[] {
    return this.loadState().applied;
  }

  async migrate(targetVersion?: string): Promise<{ ran: string[]; skipped: number }> {
    const toRun = this.pending(targetVersion);
    const ran: string[] = [];

    if (toRun.length === 0) {
      return { ran, skipped: 0 };
    }

    const state = this.loadState();

    for (const migration of toRun) {
      await migration.up();
      state.applied.push({
        version: migration.version,
        appliedAt: new Date().toISOString(),
        ...(migration.description ? { description: migration.description } : {}),
      });
      this.saveState(state);
      ran.push(migration.version);
    }

    return { ran, skipped: 0 };
  }

  async rollback(steps = 1): Promise<{ reverted: string[] }> {
    const state = this.loadState();
    const reverted: string[] = [];

    for (let i = 0; i < steps; i++) {
      const last = state.applied[state.applied.length - 1];
      if (!last) break;

      const migration = this.migrations.find((m) => m.version === last.version);
      if (!migration) {
        throw new Error(`Cannot rollback ${last.version}: migration not registered`);
      }
      if (!migration.down) {
        throw new Error(`Migration ${last.version} has no down() defined`);
      }

      await migration.down();
      state.applied.pop();
      this.saveState(state);
      reverted.push(last.version);
    }

    return { reverted };
  }
}

export default MigrationRunner;
