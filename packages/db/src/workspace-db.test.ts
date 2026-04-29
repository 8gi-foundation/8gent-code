/**
 * Tests for the workspace-shared SQLite database.
 *
 * Coverage:
 * 1. Schema initialization + migration tracking
 * 2. CRUD on all 5 core tables (kv_store, agent_sessions, app_state, skill_state, memory_index)
 * 3. Persistence across simulated restarts (close + reopen)
 * 4. Concurrent access — second instance reads while first writes (WAL)
 * 5. Migration idempotency (re-applying does not duplicate rows or fail)
 * 6. Workspace path resolution + .8gent dir auto-creation
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MIGRATIONS,
	applyMigrations,
	currentSchemaVersion,
	targetSchemaVersion,
} from "./migrations.js";
import { WorkspaceDb, resolveWorkspaceDbPath } from "./workspace-db.js";

let tmpRoot: string;
let dbPath: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-db-test-"));
	dbPath = path.join(tmpRoot, ".8gent", "state.db");
});

afterEach(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// best effort
	}
});

// ── Path resolution ───────────────────────────────────────────────────

describe("resolveWorkspaceDbPath", () => {
	it("creates .8gent/ if missing and returns the state.db path", () => {
		const dotDir = path.join(tmpRoot, ".8gent");
		expect(fs.existsSync(dotDir)).toBe(false);

		const resolved = resolveWorkspaceDbPath(tmpRoot);

		expect(resolved).toBe(path.join(dotDir, "state.db"));
		expect(fs.existsSync(dotDir)).toBe(true);
	});

	it("does not error if .8gent/ already exists", () => {
		fs.mkdirSync(path.join(tmpRoot, ".8gent"), { recursive: true });
		const resolved = resolveWorkspaceDbPath(tmpRoot);
		expect(fs.existsSync(resolved.replace(/state\.db$/, ""))).toBe(true);
	});
});

// ── Schema / migrations ───────────────────────────────────────────────

describe("schema and migrations", () => {
	it("creates state.db with WAL mode and applies migrations on first open", () => {
		const db = new WorkspaceDb({ dbPath });

		expect(fs.existsSync(dbPath)).toBe(true);
		expect(db.getSchemaVersion()).toBe(targetSchemaVersion());
		expect(db.getSchemaVersion()).toBeGreaterThan(0);

		// WAL: bun:sqlite returns "wal" in lowercase
		const journalMode = db.db
			.query<{ journal_mode: string }, []>("PRAGMA journal_mode")
			.get();
		expect(journalMode?.journal_mode.toLowerCase()).toBe("wal");

		db.close();
	});

	it("creates all 5 core tables", () => {
		const db = new WorkspaceDb({ dbPath });
		const tables = db.db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.all()
			.map((r) => r.name);

		for (const t of ["kv_store", "agent_sessions", "app_state", "skill_state", "memory_index"]) {
			expect(tables).toContain(t);
		}
		db.close();
	});

	it("is idempotent: re-applying migrations does not duplicate rows or fail", () => {
		const db = new WorkspaceDb({ dbPath });
		const versionAfterFirst = db.getSchemaVersion();
		const rowCountBefore = db.db
			.query<{ c: number }, []>("SELECT COUNT(*) as c FROM schema_migrations")
			.get()?.c;

		const newlyApplied = applyMigrations(db.db);
		expect(newlyApplied).toEqual([]);

		const rowCountAfter = db.db
			.query<{ c: number }, []>("SELECT COUNT(*) as c FROM schema_migrations")
			.get()?.c;
		expect(rowCountAfter).toBe(rowCountBefore!);
		expect(db.getSchemaVersion()).toBe(versionAfterFirst);
		db.close();
	});

	it("currentSchemaVersion returns 0 on a brand-new database without migrations", () => {
		const rawPath = path.join(tmpRoot, "raw.db");
		const raw = new Database(rawPath, { create: true });
		expect(currentSchemaVersion(raw)).toBe(0);
		raw.close();
	});

	it("MIGRATIONS array is non-empty and monotonic", () => {
		expect(MIGRATIONS.length).toBeGreaterThan(0);
		let prev = 0;
		for (const m of MIGRATIONS) {
			expect(m.version).toBeGreaterThan(prev);
			prev = m.version;
		}
	});
});

// ── kv_store ──────────────────────────────────────────────────────────

describe("kv_store", () => {
	it("set, get, delete round trip with structured values", () => {
		const db = new WorkspaceDb({ dbPath });

		db.kvSet("user.preferences", { theme: "dark", lang: "en" });
		const got = db.kvGet<{ theme: string; lang: string }>("user.preferences");
		expect(got).toEqual({ theme: "dark", lang: "en" });

		expect(db.kvDelete("user.preferences")).toBe(true);
		expect(db.kvGet("user.preferences")).toBeNull();
		expect(db.kvDelete("user.preferences")).toBe(false);
		db.close();
	});

	it("upserts on conflict and updates the timestamp", () => {
		const db = new WorkspaceDb({ dbPath });
		db.kvSet("k", "v1");
		const first = db.kvGetEntry("k");
		expect(first?.value).toBe("v1");

		db.kvSet("k", "v2");
		const second = db.kvGetEntry("k");
		expect(second?.value).toBe("v2");
		expect(second!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);
		db.close();
	});

	it("filters by namespace", () => {
		const db = new WorkspaceDb({ dbPath });
		db.kvSet("a", 1, "ns1");
		db.kvSet("b", 2, "ns1");
		db.kvSet("c", 3, "ns2");

		const ns1 = db.kvList("ns1");
		expect(ns1.map((e) => e.key).sort()).toEqual(["a", "b"]);

		const all = db.kvList();
		expect(all.length).toBe(3);
		db.close();
	});
});

// ── agent_sessions ────────────────────────────────────────────────────

describe("agent_sessions", () => {
	it("starts, updates, ends and lists sessions", () => {
		const db = new WorkspaceDb({ dbPath });

		const session = db.startAgentSession({
			id: "sess-1",
			agentName: "8gent-code",
			channel: "os",
			model: "eight-1.0-q3:14b",
			provider: "8gent",
			metadata: { workspaceRoot: tmpRoot },
		});

		expect(session.status).toBe("active");
		expect(session.tokensIn).toBe(0);

		db.updateAgentSession("sess-1", { tokensIn: 1500, tokensOut: 800 });
		const updated = db.getAgentSession("sess-1");
		expect(updated?.tokensIn).toBe(1500);
		expect(updated?.tokensOut).toBe(800);

		const ended = db.endAgentSession("sess-1", "completed");
		expect(ended?.status).toBe("completed");
		expect(ended?.endedAt).toBeGreaterThan(0);

		const active = db.listAgentSessions({ status: "active" });
		expect(active.length).toBe(0);
		const completed = db.listAgentSessions({ status: "completed" });
		expect(completed.length).toBe(1);
		db.close();
	});

	it("supports parent_id for sub-sessions", () => {
		const db = new WorkspaceDb({ dbPath });
		db.startAgentSession({ id: "parent", agentName: "main" });
		db.startAgentSession({ id: "child", agentName: "sub", parentId: "parent" });

		const child = db.getAgentSession("child");
		expect(child?.parentId).toBe("parent");
		db.close();
	});
});

// ── app_state ─────────────────────────────────────────────────────────

describe("app_state", () => {
	it("scopes state per app and per key", () => {
		const db = new WorkspaceDb({ dbPath });
		db.setAppState("tui", "lastTab", "chat");
		db.setAppState("tui", "windowSize", { cols: 120, rows: 40 });
		db.setAppState("dashboard", "lastTab", "metrics");

		expect(db.getAppState("tui", "lastTab")).toBe("chat");
		expect(db.getAppState<{ cols: number }>("tui", "windowSize")?.cols).toBe(120);
		expect(db.getAppState("dashboard", "lastTab")).toBe("metrics");

		const tuiAll = db.listAppState("tui");
		expect(tuiAll.length).toBe(2);

		expect(db.deleteAppState("tui", "lastTab")).toBe(true);
		expect(db.getAppState("tui", "lastTab")).toBeNull();
		db.close();
	});
});

// ── skill_state ───────────────────────────────────────────────────────

describe("skill_state", () => {
	it("tracks execution count and last_executed_at", () => {
		const db = new WorkspaceDb({ dbPath });

		db.setSkillState("CORE", "loaded", true);
		expect(db.getSkillState<boolean>("CORE", "loaded")).toBe(true);

		const first = db.recordSkillExecution("CORE", "loaded");
		expect(first?.executionCount).toBe(1);

		const second = db.recordSkillExecution("CORE", "loaded");
		expect(second?.executionCount).toBe(2);
		expect(second!.lastExecutedAt!).toBeGreaterThanOrEqual(first!.lastExecutedAt!);
		db.close();
	});
});

// ── memory_index ──────────────────────────────────────────────────────

describe("memory_index", () => {
	it("upserts, lists by scope/topic, deletes", () => {
		const db = new WorkspaceDb({ dbPath });

		db.upsertMemoryIndex({
			id: "idx-1",
			memoryId: "mem-abc",
			scope: "project",
			topic: "architecture",
			importance: 0.9,
		});
		db.upsertMemoryIndex({
			id: "idx-2",
			memoryId: "mem-def",
			scope: "global",
			topic: "user-preference",
			importance: 0.7,
		});
		db.upsertMemoryIndex({
			id: "idx-3",
			memoryId: "mem-ghi",
			scope: "project",
			topic: "architecture",
			importance: 0.5,
		});

		const projectArch = db.listMemoryIndex({ scope: "project", topic: "architecture" });
		expect(projectArch.length).toBe(2);
		// Highest importance first
		expect(projectArch[0]!.id).toBe("idx-1");

		// Re-upsert raises importance
		db.upsertMemoryIndex({
			id: "idx-3",
			memoryId: "mem-ghi",
			scope: "project",
			topic: "architecture",
			importance: 0.95,
		});
		const reordered = db.listMemoryIndex({ scope: "project", topic: "architecture" });
		expect(reordered[0]!.id).toBe("idx-3");

		expect(db.deleteMemoryIndex("idx-2")).toBe(true);
		expect(db.getMemoryIndexEntry("idx-2")).toBeNull();
		db.close();
	});
});

// ── persistence across restarts ──────────────────────────────────────

describe("persistence across simulated restarts", () => {
	it("agent_sessions survive close + reopen", () => {
		const first = new WorkspaceDb({ dbPath });
		first.startAgentSession({
			id: "persistent-sess",
			agentName: "8gent-code",
			model: "eight-1.0-q3:14b",
		});
		first.updateAgentSession("persistent-sess", { tokensIn: 999, tokensOut: 444 });
		first.close();

		// Simulated restart: brand new instance pointing at the same file.
		const second = new WorkspaceDb({ dbPath });
		const recovered = second.getAgentSession("persistent-sess");

		expect(recovered).not.toBeNull();
		expect(recovered!.tokensIn).toBe(999);
		expect(recovered!.tokensOut).toBe(444);
		expect(recovered!.agentName).toBe("8gent-code");
		expect(second.getSchemaVersion()).toBe(targetSchemaVersion());
		second.close();
	});

	it("kv_store and app_state survive across restarts", () => {
		const first = new WorkspaceDb({ dbPath });
		first.kvSet("workspace.last_command", "bun run tui");
		first.setAppState("tui", "theme", "dark");
		first.close();

		const second = new WorkspaceDb({ dbPath });
		expect(second.kvGet("workspace.last_command")).toBe("bun run tui");
		expect(second.getAppState("tui", "theme")).toBe("dark");
		second.close();
	});

	it("schema_migrations is preserved and not re-applied", () => {
		const first = new WorkspaceDb({ dbPath });
		const initialApplied = first.db
			.query<{ version: number }, []>(
				"SELECT version FROM schema_migrations ORDER BY version",
			)
			.all()
			.map((r) => r.version);
		first.close();

		const second = new WorkspaceDb({ dbPath });
		const reopenedApplied = second.db
			.query<{ version: number }, []>(
				"SELECT version FROM schema_migrations ORDER BY version",
			)
			.all()
			.map((r) => r.version);

		expect(reopenedApplied).toEqual(initialApplied);
		second.close();
	});
});

// ── concurrent access ────────────────────────────────────────────────

describe("concurrent access (WAL)", () => {
	it("a second instance can read rows that a first instance wrote", () => {
		const writer = new WorkspaceDb({ dbPath });
		writer.kvSet("shared", "from-writer");
		writer.checkpoint();

		const reader = new WorkspaceDb({ dbPath, skipMigrations: true });
		expect(reader.kvGet("shared")).toBe("from-writer");

		writer.kvSet("shared", "updated-from-writer");
		writer.checkpoint();

		// Reader sees the update on next query (WAL is shared via the DB file).
		expect(reader.kvGet("shared")).toBe("updated-from-writer");

		writer.close();
		reader.close();
	});

	it("concurrent writes from two instances both succeed (busy_timeout)", () => {
		const a = new WorkspaceDb({ dbPath });
		const b = new WorkspaceDb({ dbPath, skipMigrations: true });

		a.startAgentSession({ id: "from-a", agentName: "harness" });
		b.startAgentSession({ id: "from-b", agentName: "host" });

		const sessionsFromA = a.listAgentSessions();
		expect(sessionsFromA.map((s) => s.id).sort()).toEqual(["from-a", "from-b"]);

		const sessionsFromB = b.listAgentSessions();
		expect(sessionsFromB.map((s) => s.id).sort()).toEqual(["from-a", "from-b"]);

		a.close();
		b.close();
	});

	it("transactions are atomic", () => {
		const db = new WorkspaceDb({ dbPath });

		try {
			db.transaction(() => {
				db.kvSet("tx.a", 1);
				db.kvSet("tx.b", 2);
				throw new Error("rollback");
			});
		} catch {
			// expected
		}

		expect(db.kvGet("tx.a")).toBeNull();
		expect(db.kvGet("tx.b")).toBeNull();

		db.transaction(() => {
			db.kvSet("tx.a", 1);
			db.kvSet("tx.b", 2);
		});

		expect(db.kvGet("tx.a")).toBe(1);
		expect(db.kvGet("tx.b")).toBe(2);
		db.close();
	});
});
