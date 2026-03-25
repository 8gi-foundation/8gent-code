/**
 * schema-migration.ts
 * Manages database schema migrations with ordered versioning, up/down support,
 * rollback, dry run, and concurrent execution locking.
 */

export interface Migration {
  version: number;
  name: string;
  up: (db: MigrationDB) => Promise<void>;
  down: (db: MigrationDB) => Promise<void>;
}

export interface MigrationDB {
  exec(sql: string): void;
  query<T = unknown>(sql: string, params?: unknown[]): T[];
}

export interface MigrationRecord {
  version: number;
  name: string;
  applied_at: string;
}

export interface RunResult {
  applied: Migration[];
  skipped: Migration[];
  errors: { migration: Migration; error: Error }[];
}

export class MigrationRunner {
  private migrations: Migration[] = [];
  private tableName: string;
  private lockTableName: string;

  constructor(
    private db: MigrationDB,
    opts: { tableName?: string } = {}
  ) {
    this.tableName = opts.tableName ?? "_schema_migrations";
    this.lockTableName = `${this.tableName}_lock`;
    this.ensureTable();
  }

  register(migration: Migration): this {
    if (this.migrations.find((m) => m.version === migration.version)) {
      throw new Error(`Migration version ${migration.version} already registered`);
    }
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
    return this;
  }

  registerAll(migrations: Migration[]): this {
    for (const m of migrations) this.register(m);
    return this;
  }

  pending(): Migration[] {
    const applied = this.appliedVersions();
    return this.migrations.filter((m) => !applied.has(m.version));
  }

  applied(): MigrationRecord[] {
    return this.db.query<MigrationRecord>(
      `SELECT version, name, applied_at FROM ${this.tableName} ORDER BY version ASC`
    );
  }

  async run(opts: { dryRun?: boolean } = {}): Promise<RunResult> {
    const result: RunResult = { applied: [], skipped: [], errors: [] };
    const pending = this.pending();

    if (pending.length === 0) return result;
    if (opts.dryRun) {
      result.skipped = [...pending];
      return result;
    }

    this.acquireLock();
    try {
      for (const migration of pending) {
        try {
          await migration.up(this.db);
          this.markApplied(migration);
          result.applied.push(migration);
        } catch (err) {
          result.errors.push({ migration, error: err as Error });
          break; // halt on first failure
        }
      }
    } finally {
      this.releaseLock();
    }

    return result;
  }

  async rollback(steps = 1, opts: { dryRun?: boolean } = {}): Promise<Migration[]> {
    const appliedRecords = this.applied();
    const toRollback = appliedRecords
      .slice(-steps)
      .reverse()
      .map((r) => this.migrations.find((m) => m.version === r.version))
      .filter((m): m is Migration => m !== undefined);

    if (opts.dryRun) return toRollback;

    this.acquireLock();
    try {
      for (const migration of toRollback) {
        await migration.down(this.db);
        this.markReverted(migration);
      }
    } finally {
      this.releaseLock();
    }

    return toRollback;
  }

  async rollbackTo(version: number, opts: { dryRun?: boolean } = {}): Promise<Migration[]> {
    const appliedRecords = this.applied().filter((r) => r.version > version);
    const steps = appliedRecords.length;
    return this.rollback(steps, opts);
  }

  // -- private helpers --

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.lockTableName} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        locked_at TEXT NOT NULL
      )
    `);
  }

  private appliedVersions(): Set<number> {
    const rows = this.db.query<{ version: number }>(
      `SELECT version FROM ${this.tableName}`
    );
    return new Set(rows.map((r) => r.version));
  }

  private markApplied(m: Migration): void {
    this.db.exec(
      `INSERT INTO ${this.tableName} (version, name) VALUES (${m.version}, '${m.name.replace(/'/g, "''")}')`
    );
  }

  private markReverted(m: Migration): void {
    this.db.exec(`DELETE FROM ${this.tableName} WHERE version = ${m.version}`);
  }

  private acquireLock(): void {
    const existing = this.db.query<{ locked_at: string }>(
      `SELECT locked_at FROM ${this.lockTableName} WHERE id = 1`
    );
    if (existing.length > 0) {
      throw new Error(`Migration lock held since ${existing[0].locked_at}. Concurrent run prevented.`);
    }
    this.db.exec(
      `INSERT INTO ${this.lockTableName} (id, locked_at) VALUES (1, datetime('now'))`
    );
  }

  private releaseLock(): void {
    this.db.exec(`DELETE FROM ${this.lockTableName} WHERE id = 1`);
  }
}
