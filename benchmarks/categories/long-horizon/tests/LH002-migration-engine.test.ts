import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.join(import.meta.dir, "../../autoresearch/work");

// Dynamic imports from generated code
let schema: any, migration: any, executor: any, history: any;

beforeEach(async () => {
  try {
    schema = await import(path.join(WORK_DIR, "schema.ts"));
  } catch { try { schema = await import(path.join(WORK_DIR, "schema.js")); } catch {} }
  try {
    migration = await import(path.join(WORK_DIR, "migration.ts"));
  } catch { try { migration = await import(path.join(WORK_DIR, "migration.js")); } catch {} }
  try {
    executor = await import(path.join(WORK_DIR, "executor.ts"));
  } catch { try { executor = await import(path.join(WORK_DIR, "executor.js")); } catch {} }
  try {
    history = await import(path.join(WORK_DIR, "history.ts"));
  } catch { try { history = await import(path.join(WORK_DIR, "history.js")); } catch {} }
});

// ── Helper schemas ──────────────────────────────────

const schemaV1 = {
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
        { name: "email", type: "VARCHAR(255)", nullable: false, unique: true },
        { name: "name", type: "VARCHAR(100)", nullable: true },
      ],
      indexes: [],
      constraints: [],
    },
  ],
  version: 1,
};

const schemaV2 = {
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
        { name: "email", type: "VARCHAR(255)", nullable: false, unique: true },
        { name: "name", type: "VARCHAR(100)", nullable: true },
        { name: "age", type: "INTEGER", nullable: true },
      ],
      indexes: [],
      constraints: [],
    },
    {
      name: "posts",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
        { name: "title", type: "VARCHAR(255)", nullable: false },
        { name: "user_id", type: "INTEGER", nullable: false, references: { table: "users", column: "id" } },
      ],
      indexes: [],
      constraints: [],
    },
  ],
  version: 2,
};

// ── Schema Diffing ──────────────────────────────────

describe("Schema Diffing", () => {
  it("diffSchemas detects added tables", () => {
    const fn = schema.diffSchemas || schema.default?.diffSchemas;
    const diff = fn(schemaV1, schemaV2);
    expect(diff).toBeDefined();
    const addedNames = (diff.tablesAdded || []).map((t: any) => typeof t === "string" ? t : t.name);
    expect(addedNames).toContain("posts");
  });

  it("diffSchemas detects removed tables", () => {
    const fn = schema.diffSchemas || schema.default?.diffSchemas;
    const diff = fn(schemaV2, schemaV1);
    const removedNames = (diff.tablesRemoved || []).map((t: any) => typeof t === "string" ? t : t.name);
    expect(removedNames).toContain("posts");
  });

  it("diffSchemas detects added columns", () => {
    const fn = schema.diffSchemas || schema.default?.diffSchemas;
    const diff = fn(schemaV1, schemaV2);
    // users table should have columnsAdded with "age"
    const modified = diff.tablesModified || [];
    const usersModified = modified.find((t: any) => t.name === "users" || t.table === "users");
    expect(usersModified).toBeDefined();
    const addedColNames = (usersModified.columnsAdded || []).map((c: any) => typeof c === "string" ? c : c.name);
    expect(addedColNames).toContain("age");
  });

  it("diffSchemas detects removed columns", () => {
    const fn = schema.diffSchemas || schema.default?.diffSchemas;
    const diff = fn(schemaV2, schemaV1);
    const modified = diff.tablesModified || [];
    const usersModified = modified.find((t: any) => t.name === "users" || t.table === "users");
    expect(usersModified).toBeDefined();
    const removedColNames = (usersModified.columnsRemoved || []).map((c: any) => typeof c === "string" ? c : c.name);
    expect(removedColNames).toContain("age");
  });
});

// ── SQL Generation ──────────────────────────────────

describe("SQL Generation", () => {
  it("generateSQL produces CREATE TABLE / ALTER TABLE / DROP TABLE", () => {
    const diffFn = schema.diffSchemas || schema.default?.diffSchemas;
    const genFn = schema.generateSQL || schema.default?.generateSQL;
    const diff = diffFn(schemaV1, schemaV2);
    const sql = genFn(diff);
    expect(sql).toBeDefined();
    expect(Array.isArray(sql.up)).toBe(true);
    expect(Array.isArray(sql.down)).toBe(true);
    expect(sql.up.length).toBeGreaterThan(0);
    expect(sql.down.length).toBeGreaterThan(0);
    // Up should contain CREATE TABLE for posts and ALTER TABLE for users
    const upJoined = sql.up.join("\n").toUpperCase();
    expect(upJoined).toContain("CREATE TABLE");
    expect(upJoined).toContain("ALTER TABLE");
    // Down should contain DROP TABLE for posts
    const downJoined = sql.down.join("\n").toUpperCase();
    expect(downJoined).toContain("DROP TABLE");
  });
});

// ── Migration Manager ───────────────────────────────

describe("MigrationManager", () => {
  it("topological sort respects dependencies", () => {
    const MM = migration.MigrationManager || migration.default?.MigrationManager || migration.default;
    const manager = new MM();
    manager.register({
      id: "m2", name: "create-posts", timestamp: 2, up: ["CREATE TABLE posts"], down: ["DROP TABLE posts"], checksum: "abc", dependencies: ["m1"],
    });
    manager.register({
      id: "m1", name: "create-users", timestamp: 1, up: ["CREATE TABLE users"], down: ["DROP TABLE users"], checksum: "def",
    });
    const order = manager.getExecutionOrder();
    const ids = order.map((m: any) => m.id);
    expect(ids.indexOf("m1")).toBeLessThan(ids.indexOf("m2"));
  });

  it("detects circular dependencies", () => {
    const MM = migration.MigrationManager || migration.default?.MigrationManager || migration.default;
    const manager = new MM();
    manager.register({
      id: "a", name: "a", timestamp: 1, up: ["--"], down: ["--"], checksum: "a", dependencies: ["b"],
    });
    manager.register({
      id: "b", name: "b", timestamp: 2, up: ["--"], down: ["--"], checksum: "b", dependencies: ["a"],
    });
    // Should throw or return validation error
    let threw = false;
    try {
      const result = manager.getExecutionOrder();
      // Some implementations return validation result instead of throwing
      if (result?.valid === false) threw = true;
    } catch {
      threw = true;
    }
    if (!threw) {
      // Try validate() method
      try {
        const validation = manager.validate();
        expect(validation.valid).toBe(false);
        expect(validation.errors.length).toBeGreaterThan(0);
        threw = true;
      } catch {}
    }
    expect(threw).toBe(true);
  });

  it("getPending returns only unapplied migrations in order", () => {
    const MM = migration.MigrationManager || migration.default?.MigrationManager || migration.default;
    const manager = new MM();
    manager.register({ id: "m1", name: "first", timestamp: 1, up: ["--"], down: ["--"], checksum: "a" });
    manager.register({ id: "m2", name: "second", timestamp: 2, up: ["--"], down: ["--"], checksum: "b" });
    manager.register({ id: "m3", name: "third", timestamp: 3, up: ["--"], down: ["--"], checksum: "c" });
    const pending = manager.getPending(["m1"]);
    const ids = pending.map((m: any) => m.id);
    expect(ids).not.toContain("m1");
    expect(ids).toContain("m2");
    expect(ids).toContain("m3");
    expect(ids.indexOf("m2")).toBeLessThan(ids.indexOf("m3"));
  });

  it("getRollbackPlan returns reverse order", () => {
    const MM = migration.MigrationManager || migration.default?.MigrationManager || migration.default;
    const manager = new MM();
    manager.register({ id: "m1", name: "first", timestamp: 1, up: ["--"], down: ["--"], checksum: "a" });
    manager.register({ id: "m2", name: "second", timestamp: 2, up: ["--"], down: ["--"], checksum: "b" });
    manager.register({ id: "m3", name: "third", timestamp: 3, up: ["--"], down: ["--"], checksum: "c" });
    const plan = manager.getRollbackPlan("m1", ["m1", "m2", "m3"]);
    const ids = plan.map((m: any) => m.id);
    // Should rollback m3 then m2 (reverse order), not including target m1
    expect(ids.indexOf("m3")).toBeLessThan(ids.indexOf("m2"));
    expect(ids).not.toContain("m1");
  });
});

// ── Migration Executor ──────────────────────────────

describe("MigrationExecutor", () => {
  it("runs up migrations in order", async () => {
    const ME = executor.MigrationExecutor || executor.default?.MigrationExecutor || executor.default;
    const executed: string[] = [];
    const exec = new ME({
      onProgress: (step: any) => executed.push(step.migrationId + ":" + step.statement),
    });
    const migrations = [
      { id: "m1", name: "first", timestamp: 1, up: ["CREATE TABLE a"], down: ["DROP TABLE a"], checksum: "a" },
      { id: "m2", name: "second", timestamp: 2, up: ["CREATE TABLE b"], down: ["DROP TABLE b"], checksum: "b" },
    ];
    const result = await exec.migrate(migrations);
    expect(result).toBeDefined();
    expect(result.applied).toContain("m1");
    expect(result.applied).toContain("m2");
    expect(result.applied.indexOf("m1")).toBeLessThan(result.applied.indexOf("m2"));
  });

  it("dry run collects statements without executing", async () => {
    const ME = executor.MigrationExecutor || executor.default?.MigrationExecutor || executor.default;
    const exec = new ME({ dryRun: true });
    const migrations = [
      { id: "m1", name: "first", timestamp: 1, up: ["CREATE TABLE a", "CREATE INDEX idx ON a(id)"], down: ["DROP TABLE a"], checksum: "a" },
    ];
    const result = await exec.migrate(migrations);
    expect(result).toBeDefined();
    expect(result.dryRun).toBe(true);
    expect(Array.isArray(result.statements)).toBe(true);
    expect(result.statements.length).toBeGreaterThanOrEqual(1);
    // Statements should contain the SQL
    const stmts = result.statements.join("\n").toUpperCase();
    expect(stmts).toContain("CREATE TABLE");
  });

  it("stops on failure", async () => {
    const ME = executor.MigrationExecutor || executor.default?.MigrationExecutor || executor.default;
    // Create an executor that simulates failure on second migration
    let callCount = 0;
    const exec = new ME({
      onProgress: (step: any) => {
        callCount++;
        if (step.migrationId === "m2") {
          throw new Error("Simulated failure");
        }
      },
    });
    const migrations = [
      { id: "m1", name: "first", timestamp: 1, up: ["OK"], down: ["OK"], checksum: "a" },
      { id: "m2", name: "second", timestamp: 2, up: ["FAIL"], down: ["OK"], checksum: "b" },
      { id: "m3", name: "third", timestamp: 3, up: ["OK"], down: ["OK"], checksum: "c" },
    ];
    let result: any;
    try {
      result = await exec.migrate(migrations);
    } catch (e: any) {
      // Some implementations throw on failure
      result = { failed: { id: "m2", error: e.message }, applied: ["m1"] };
    }
    // m3 should not have been applied
    if (result.applied) {
      expect(result.applied).not.toContain("m3");
    }
    if (result.failed) {
      expect(result.failed.id).toBe("m2");
    }
  });
});

// ── Migration History ───────────────────────────────

describe("MigrationHistory", () => {
  it("tracks applied migrations", () => {
    const MH = history.MigrationHistory || history.default?.MigrationHistory || history.default;
    const hist = new MH();
    hist.record("m1", "up", 50);
    hist.record("m2", "up", 30);
    const applied = hist.getApplied();
    expect(applied).toContain("m1");
    expect(applied).toContain("m2");
    expect(hist.isApplied("m1")).toBe(true);
    expect(hist.isApplied("m2")).toBe(true);
    expect(hist.isApplied("m3")).toBe(false);
  });

  it("handles up/down correctly — down removes from applied", () => {
    const MH = history.MigrationHistory || history.default?.MigrationHistory || history.default;
    const hist = new MH();
    hist.record("m1", "up", 50);
    hist.record("m2", "up", 30);
    expect(hist.isApplied("m2")).toBe(true);
    hist.record("m2", "down", 10);
    expect(hist.isApplied("m2")).toBe(false);
    expect(hist.isApplied("m1")).toBe(true);
    // Timeline should still show all entries
    const timeline = hist.getTimeline();
    expect(timeline.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Lock Mechanism ──────────────────────────────────

describe("Lock Mechanism", () => {
  it("prevents concurrent execution", async () => {
    const ME = executor.MigrationExecutor || executor.default?.MigrationExecutor || executor.default;
    const exec1 = new ME({});
    const exec2 = new ME({});
    // acquireLock/releaseLock — if the executor exposes them
    if (typeof exec1.acquireLock === "function") {
      const locked = await exec1.acquireLock();
      expect(locked).toBe(true);
      // Second acquire should fail or return false
      let secondLocked: boolean;
      try {
        secondLocked = await exec2.acquireLock();
      } catch {
        secondLocked = false;
      }
      expect(secondLocked).toBe(false);
      await exec1.releaseLock();
      // Now second should work
      const afterRelease = await exec2.acquireLock();
      expect(afterRelease).toBe(true);
      await exec2.releaseLock();
    } else {
      // Lock might be internal — test via concurrent migrate calls
      const migrations = [
        { id: "m1", name: "slow", timestamp: 1, up: ["SLOW"], down: ["OK"], checksum: "a" },
      ];
      // Just verify it doesn't crash with concurrent calls
      const [r1, r2] = await Promise.allSettled([
        exec1.migrate(migrations),
        exec2.migrate(migrations),
      ]);
      // At least one should succeed
      const succeeded = [r1, r2].filter(r => r.status === "fulfilled");
      expect(succeeded.length).toBeGreaterThanOrEqual(1);
    }
  });
});
