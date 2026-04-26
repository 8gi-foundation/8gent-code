/**
 * Soft Delete + Versioning Test Coverage
 *
 * Tests for the forget() (soft delete) and update() (versioning) methods
 * on MemoryStore. Verifies internal DB state via raw SQL when needed.
 *
 * Issue: #1367
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.js";
import type { CoreMemory, SemanticMemory } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function testDbPath(): string {
	return join(tmpdir(), `memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeCoreMem(overrides: Partial<CoreMemory> = {}): CoreMemory {
	const now = Date.now();
	return {
		id: `mem_test_${Math.random().toString(36).slice(2, 8)}`,
		type: "core",
		scope: "project",
		category: "architecture",
		key: "test-key",
		title: "Test Memory",
		content: "This is a test memory for verification",
		confidence: 0.9,
		evidenceCount: 1,
		tags: ["test"],
		importance: 0.7,
		decayFactor: 1.0,
		accessCount: 0,
		lastAccessed: now,
		createdAt: now,
		updatedAt: now,
		version: 1,
		source: "user_explicit",
		...overrides,
	};
}

function makeSemanticMem(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
	const now = Date.now();
	return {
		id: `mem_test_${Math.random().toString(36).slice(2, 8)}`,
		type: "semantic",
		scope: "global",
		category: "fact",
		key: "semantic-test",
		value: "Some known fact for testing",
		confidence: 0.8,
		evidenceCount: 2,
		tags: ["semantic", "test"],
		relatedKeys: [],
		learnedAt: now,
		lastConfirmed: now,
		importance: 0.6,
		decayFactor: 1.0,
		accessCount: 0,
		lastAccessed: now,
		createdAt: now,
		updatedAt: now,
		version: 1,
		source: "observation",
		...overrides,
	};
}

// ── Test Suite ───────────────────────────────────────────────────────────

let store: MemoryStore;
let dbPath: string;

beforeEach(() => {
	dbPath = testDbPath();
	store = new MemoryStore(dbPath);
});

afterEach(() => {
	try {
		store.close();
	} catch {
		// already closed
	}
	// Clean up temp DB files
	for (const suffix of ["", "-wal", "-shm"]) {
		const p = dbPath + suffix;
		if (existsSync(p)) unlinkSync(p);
	}
});

// ── Soft Delete Tests ────────────────────────────────────────────────────

describe("forget() — soft delete", () => {
	it("sets deleted_at instead of removing the row", () => {
		const mem = makeCoreMem();
		const id = store.write(mem);

		const result = store.forget(id, "no longer needed");
		expect(result).toBe(true);

		// Verify via raw SQL that row still exists with deleted_at set
		const rawDb = new Database(dbPath, { readonly: true });
		const row = rawDb.prepare("SELECT id, deleted_at FROM memories WHERE id = ?").get(id) as {
			id: string;
			deleted_at: number | null;
		} | null;
		rawDb.close();

		expect(row).not.toBeNull();
		expect(row?.id).toBe(id);
		expect(row?.deleted_at).not.toBeNull();
		expect(typeof row?.deleted_at).toBe("number");
		expect(row?.deleted_at!).toBeGreaterThan(0);
	});

	it("makes forgotten memories invisible to normal get()", () => {
		const mem = makeCoreMem();
		const id = store.write(mem);

		// Visible before forget
		expect(store.get(id)).not.toBeNull();

		store.forget(id, "hidden");

		// Invisible after forget
		expect(store.get(id)).toBeNull();
	});

	it("makes forgotten memories visible with includeDeleted flag", () => {
		const mem = makeCoreMem();
		const id = store.write(mem);

		store.forget(id, "soft deleted");

		// Normal get returns null
		expect(store.get(id)).toBeNull();

		// includeDeleted returns the memory
		const retrieved = store.get(id, true);
		expect(retrieved).not.toBeNull();
		expect(retrieved?.id).toBe(id);
	});

	it("returns false for non-existent memory", () => {
		const result = store.forget("mem_does_not_exist", "test");
		expect(result).toBe(false);
	});

	it("returns false for already-deleted memory", () => {
		const mem = makeCoreMem();
		const id = store.write(mem);

		// First forget succeeds
		expect(store.forget(id, "first delete")).toBe(true);

		// Second forget returns false (already deleted)
		expect(store.forget(id, "second delete")).toBe(false);
	});

	it("creates a version snapshot before deletion", () => {
		const mem = makeCoreMem();
		const id = store.write(mem);

		store.forget(id, "archiving");

		// Check memory_versions via raw SQL
		const rawDb = new Database(dbPath, { readonly: true });
		const versions = rawDb
			.prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC")
			.all(id) as Array<{
			id: string;
			memory_id: string;
			version: number;
			data_snapshot: string;
			changed_by: string;
			change_reason: string;
			created_at: number;
		}>;
		rawDb.close();

		expect(versions.length).toBe(1);
		expect(versions[0].memory_id).toBe(id);
		expect(versions[0].version).toBe(1);
		expect(versions[0].changed_by).toBe("user");
		expect(versions[0].change_reason).toBe("archiving");

		// Verify the snapshot contains the original data
		const snapshot = JSON.parse(versions[0].data_snapshot);
		expect(snapshot.id).toBe(id);
		expect(snapshot.type).toBe("core");
		expect(snapshot.title).toBe("Test Memory");
	});

	it("uses 'deleted' as default reason when none provided", () => {
		const mem = makeCoreMem();
		const id = store.write(mem);

		store.forget(id);

		const rawDb = new Database(dbPath, { readonly: true });
		const version = rawDb
			.prepare("SELECT change_reason FROM memory_versions WHERE memory_id = ?")
			.get(id) as { change_reason: string } | null;
		rawDb.close();

		expect(version).not.toBeNull();
		expect(version?.change_reason).toBe("deleted");
	});

	it("excludes forgotten memories from stats()", () => {
		const mem1 = makeCoreMem({ id: "mem_stats_a" });
		const mem2 = makeCoreMem({ id: "mem_stats_b" });
		store.write(mem1);
		store.write(mem2);

		const before = store.getStats();
		expect(before.total).toBe(2);

		store.forget("mem_stats_a", "remove from stats");

		const after = store.getStats();
		expect(after.total).toBe(1);
	});

	it("excludes forgotten memories from stats byType counts", () => {
		const core = makeCoreMem({ id: "mem_type_a" });
		const semantic = makeSemanticMem({ id: "mem_type_b" });
		store.write(core);
		store.write(semantic);

		const before = store.getStats();
		expect(before.byType.core).toBe(1);
		expect(before.byType.semantic).toBe(1);

		store.forget("mem_type_a", "remove core");

		const after = store.getStats();
		expect(after.byType.core).toBe(0);
		expect(after.byType.semantic).toBe(1);
	});
});

// ── Versioning Tests ─────────────────────────────────────────────────────

describe("update() — versioning", () => {
	it("increments version number", () => {
		const mem = makeCoreMem({ id: "mem_ver_inc" });
		store.write(mem);

		store.update("mem_ver_inc", { content: "Updated content" }, "improve", "agent");

		const updated = store.get("mem_ver_inc");
		expect(updated).not.toBeNull();
		// version should be 2 after one update
		expect(updated?.version).toBe(2);
	});

	it("creates version snapshot of previous state", () => {
		const mem = makeCoreMem({ id: "mem_snap" });
		store.write(mem);

		store.update("mem_snap", { content: "New content" }, "refine", "agent");

		const rawDb = new Database(dbPath, { readonly: true });
		const versions = rawDb
			.prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version")
			.all("mem_snap") as Array<{
			version: number;
			data_snapshot: string;
			changed_by: string;
			change_reason: string;
		}>;
		rawDb.close();

		expect(versions.length).toBe(1);
		// Snapshot should be version 1 (the previous state)
		expect(versions[0].version).toBe(1);

		const snapshot = JSON.parse(versions[0].data_snapshot) as CoreMemory;
		expect(snapshot.content).toBe("This is a test memory for verification");
	});

	it("creates sequential version snapshots on multiple updates", () => {
		const mem = makeCoreMem({ id: "mem_multi" });
		store.write(mem);

		store.update("mem_multi", { content: "v2 content" }, "second version", "agent");
		store.update("mem_multi", { content: "v3 content" }, "third version", "agent");
		store.update("mem_multi", { content: "v4 content" }, "fourth version", "agent");

		const rawDb = new Database(dbPath, { readonly: true });
		const versions = rawDb
			.prepare(
				"SELECT version, data_snapshot, change_reason FROM memory_versions WHERE memory_id = ? ORDER BY version",
			)
			.all("mem_multi") as Array<{
			version: number;
			data_snapshot: string;
			change_reason: string;
		}>;
		rawDb.close();

		expect(versions.length).toBe(3);

		// Version 1 snapshot (original)
		expect(versions[0].version).toBe(1);
		expect(versions[0].change_reason).toBe("second version");
		const v1 = JSON.parse(versions[0].data_snapshot) as CoreMemory;
		expect(v1.content).toBe("This is a test memory for verification");

		// Version 2 snapshot
		expect(versions[1].version).toBe(2);
		expect(versions[1].change_reason).toBe("third version");
		const v2 = JSON.parse(versions[1].data_snapshot) as CoreMemory;
		expect(v2.content).toBe("v2 content");

		// Version 3 snapshot
		expect(versions[2].version).toBe(3);
		expect(versions[2].change_reason).toBe("fourth version");
		const v3 = JSON.parse(versions[2].data_snapshot) as CoreMemory;
		expect(v3.content).toBe("v3 content");

		// Current state should be v4
		const current = store.get("mem_multi") as CoreMemory;
		expect(current.version).toBe(4);
		expect(current.content).toBe("v4 content");
	});

	it("preserves the full data blob in version snapshot", () => {
		const mem = makeCoreMem({
			id: "mem_blob",
			title: "Blob Test",
			content: "Original content with details",
			tags: ["alpha", "beta"],
			confidence: 0.95,
			evidenceCount: 5,
			importance: 0.8,
		});
		store.write(mem);

		store.update("mem_blob", { content: "Changed content" }, "update blob", "system");

		const rawDb = new Database(dbPath, { readonly: true });
		const row = rawDb
			.prepare("SELECT data_snapshot FROM memory_versions WHERE memory_id = ?")
			.get("mem_blob") as { data_snapshot: string } | null;
		rawDb.close();

		expect(row).not.toBeNull();
		const snapshot = JSON.parse(row?.data_snapshot ?? "{}") as CoreMemory;

		// All original fields should be preserved
		expect(snapshot.id).toBe("mem_blob");
		expect(snapshot.type).toBe("core");
		expect(snapshot.title).toBe("Blob Test");
		expect(snapshot.content).toBe("Original content with details");
		expect(snapshot.tags).toEqual(["alpha", "beta"]);
		expect(snapshot.confidence).toBe(0.95);
		expect(snapshot.evidenceCount).toBe(5);
		expect(snapshot.importance).toBe(0.8);
		expect(snapshot.version).toBe(1);
	});

	it("records changed_by and change_reason", () => {
		const mem = makeCoreMem({ id: "mem_audit" });
		store.write(mem);

		store.update("mem_audit", { content: "Audited" }, "quarterly review", "compliance-agent");

		const rawDb = new Database(dbPath, { readonly: true });
		const row = rawDb
			.prepare("SELECT changed_by, change_reason FROM memory_versions WHERE memory_id = ?")
			.get("mem_audit") as { changed_by: string; change_reason: string } | null;
		rawDb.close();

		expect(row).not.toBeNull();
		expect(row?.changed_by).toBe("compliance-agent");
		expect(row?.change_reason).toBe("quarterly review");
	});

	it("returns false for non-existent memory", () => {
		const result = store.update("mem_ghost", { content: "nope" }, "test", "agent");
		expect(result).toBe(false);
	});

	it("returns false for deleted memory", () => {
		const mem = makeCoreMem({ id: "mem_del_upd" });
		store.write(mem);

		store.forget("mem_del_upd", "gone");

		const result = store.update("mem_del_upd", { content: "revive?" }, "attempt", "agent");
		expect(result).toBe(false);
	});

	it("updates the data blob stored in the memories table", () => {
		const mem = makeCoreMem({ id: "mem_merged" });
		store.write(mem);

		store.update(
			"mem_merged",
			{ content: "Merged content", importance: 0.99 } as Partial<CoreMemory>,
			"merge test",
			"agent",
		);

		// Verify via raw SQL that the data column is updated
		const rawDb = new Database(dbPath, { readonly: true });
		const row = rawDb
			.prepare("SELECT data, version, importance FROM memories WHERE id = ?")
			.get("mem_merged") as {
			data: string;
			version: number;
			importance: number;
		} | null;
		rawDb.close();

		expect(row).not.toBeNull();
		expect(row?.version).toBe(2);
		expect(row?.importance).toBe(0.99);

		const data = JSON.parse(row?.data ?? "{}") as CoreMemory;
		expect(data.content).toBe("Merged content");
		expect(data.importance).toBe(0.99);
		expect(data.version).toBe(2);
	});

	it("sets updated_at on the memory row after update", () => {
		const mem = makeCoreMem({ id: "mem_ts" });
		store.write(mem);

		const rawDb = new Database(dbPath, { readonly: true });
		const before = rawDb.prepare("SELECT updated_at FROM memories WHERE id = ?").get("mem_ts") as {
			updated_at: number;
		};
		rawDb.close();

		const beforeTime = before.updated_at;

		store.update("mem_ts", { content: "Updated" }, "ts test", "agent");

		const rawDb2 = new Database(dbPath, { readonly: true });
		const after = rawDb2.prepare("SELECT updated_at FROM memories WHERE id = ?").get("mem_ts") as {
			updated_at: number;
		};
		rawDb2.close();

		expect(after.updated_at).toBeGreaterThanOrEqual(beforeTime);
	});
});

// ── Integration: forget + update interplay ──────────────────────────────

describe("forget + update interplay", () => {
	it("update creates snapshot, then forget creates another snapshot", () => {
		const mem = makeCoreMem({ id: "mem_combo" });
		store.write(mem);

		store.update("mem_combo", { content: "v2" }, "first change", "agent");
		store.forget("mem_combo", "done with it");

		const rawDb = new Database(dbPath, { readonly: true });
		const versions = rawDb
			.prepare(
				"SELECT version, change_reason FROM memory_versions WHERE memory_id = ? ORDER BY version",
			)
			.all("mem_combo") as Array<{ version: number; change_reason: string }>;
		rawDb.close();

		expect(versions.length).toBe(2);
		// First snapshot: before the update (version 1)
		expect(versions[0].version).toBe(1);
		expect(versions[0].change_reason).toBe("first change");
		// Second snapshot: before the forget (version 2)
		expect(versions[1].version).toBe(2);
		expect(versions[1].change_reason).toBe("done with it");
	});

	it("cannot update after forget, but version history is preserved", () => {
		const mem = makeCoreMem({ id: "mem_preserved" });
		store.write(mem);

		store.update("mem_preserved", { content: "changed" }, "edit", "agent");
		store.forget("mem_preserved", "bye");

		// Update should fail
		const result = store.update("mem_preserved", { content: "revive" }, "attempt", "agent");
		expect(result).toBe(false);

		// But version history still exists
		const rawDb = new Database(dbPath, { readonly: true });
		const count = rawDb
			.prepare("SELECT COUNT(*) as c FROM memory_versions WHERE memory_id = ?")
			.get("mem_preserved") as { c: number };
		rawDb.close();

		expect(count.c).toBe(2); // one from update, one from forget
	});
});
