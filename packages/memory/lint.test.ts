/**
 * Tests for lintMemory and lintReportToMarkdown.
 *
 * Covers:
 * 1. Clean state returns high score
 * 2. Detects orphan entities
 * 3. Detects contradictions
 * 4. Detects stale memories
 * 5. Detects broken references
 * 6. Detects consolidation gaps
 * 7. Score penalties accumulate
 * 8. lintReportToMarkdown produces valid markdown
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { KnowledgeGraph } from "./graph.js";
import { lintMemory, lintReportToMarkdown } from "./lint.js";

const TEST_DB = "/tmp/test-memory-lint.db";
const DAY_MS = 24 * 60 * 60 * 1000;

let db: Database;
let graph: KnowledgeGraph;

function cleanup() {
	for (const suffix of ["", "-wal", "-shm"]) {
		const p = TEST_DB + suffix;
		if (existsSync(p)) unlinkSync(p);
	}
}

function createMemoriesTable(db: Database) {
	db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, type TEXT, scope TEXT, data TEXT, content_text TEXT NOT NULL,
      tags TEXT, importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0,
      last_accessed INTEGER, confidence REAL, evidence_count INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1, source TEXT DEFAULT 'test', source_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
      consolidation_level TEXT DEFAULT 'raw'
    )
  `);
	db.run(`
    CREATE TABLE IF NOT EXISTS consolidation_log (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
    )
  `);
}

function insertMemory(
	db: Database,
	overrides: Partial<{
		id: string;
		content_text: string;
		importance: number;
		last_accessed: number | null;
		created_at: number;
		consolidation_level: string;
		deleted_at: number | null;
	}> = {},
) {
	const now = Date.now();
	const id = overrides.id ?? `mem_${Math.random().toString(36).slice(2, 10)}`;
	db.prepare(
		`INSERT INTO memories (id, type, scope, content_text, importance, last_accessed, created_at, updated_at, consolidation_level, deleted_at)
     VALUES (?, 'semantic', 'global', ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		overrides.content_text ?? "test memory content",
		overrides.importance ?? 0.5,
		overrides.last_accessed ?? now,
		overrides.created_at ?? now,
		now,
		overrides.consolidation_level ?? "raw",
		overrides.deleted_at ?? null,
	);
	return id;
}

describe("lintMemory", () => {
	beforeEach(() => {
		cleanup();
		db = new Database(TEST_DB);
		createMemoriesTable(db);
		graph = new KnowledgeGraph(db);
	});

	afterEach(() => {
		db.close();
		cleanup();
	});

	// ── Test 1: Clean state returns high score ────────────────────────────

	it("clean state returns high score", () => {
		const now = Date.now();

		// Add entities with relationships (not orphans)
		const e1 = graph.addEntity("concept", "authentication");
		const e2 = graph.addEntity("concept", "security");
		graph.addRelationship(e1, e2, "related_to");

		// Add healthy memories that mention the entities
		insertMemory(db, {
			content_text: "authentication is important for security",
			importance: 0.8,
			last_accessed: now,
			created_at: now,
			consolidation_level: "consolidated",
		});

		// Add a consolidation log entry (recent)
		db.prepare("INSERT INTO consolidation_log (id, created_at) VALUES (?, ?)").run("clog_1", now);

		const report = lintMemory(db, graph);
		expect(report.score).toBeGreaterThanOrEqual(80);
		expect(report.orphans).toHaveLength(0);
		expect(report.broken).toHaveLength(0);
	});

	// ── Test 2: Detects orphan entities ───────────────────────────────────

	it("detects orphan entities", () => {
		// Entity with no relationships AND no mentions
		graph.addEntity("concept", "xyzorphanthing");

		// Non-orphan: has a relationship
		const e2 = graph.addEntity("concept", "linked-concept");
		const e3 = graph.addEntity("concept", "other-concept");
		graph.addRelationship(e2, e3, "related_to");

		// Add a memory so health doesn't give score of 100 on 0 memories
		insertMemory(db, {
			content_text: "some basic memory content",
			importance: 0.7,
		});

		const report = lintMemory(db, graph);
		expect(report.orphans.length).toBeGreaterThanOrEqual(1);
		const orphanNames = report.orphans.map((o) => o.entity.name);
		expect(orphanNames).toContain("xyzorphanthing");
	});

	// ── Test 3: Detects contradictions ────────────────────────────────────

	it("detects contradictions", () => {
		const now = Date.now();

		// Insert two contradictory memories with sufficient importance
		insertMemory(db, {
			id: "mem_a",
			content_text: "the project uses postgres for the main database",
			importance: 0.8,
			created_at: now - 1000,
		});
		insertMemory(db, {
			id: "mem_b",
			content_text: "the project does not uses postgres for the main database",
			importance: 0.8,
			created_at: now,
		});

		const report = lintMemory(db, graph);
		expect(report.contradictions.length).toBeGreaterThanOrEqual(1);
	});

	// ── Test 4: Detects stale memories ────────────────────────────────────

	it("detects stale memories", () => {
		const now = Date.now();
		const sixtyDaysAgo = now - 60 * DAY_MS;

		insertMemory(db, {
			id: "stale_1",
			content_text: "old forgotten memory",
			importance: 0.1,
			last_accessed: sixtyDaysAgo,
			created_at: sixtyDaysAgo,
		});

		const report = lintMemory(db, graph);
		expect(report.stale.length).toBeGreaterThanOrEqual(1);
		const staleIds = report.stale.map((s) => s.id);
		expect(staleIds).toContain("stale_1");
		expect(report.stale[0].daysSinceAccess).toBeGreaterThanOrEqual(59);
	});

	// ── Test 5: Detects broken references ─────────────────────────────────

	it("detects broken references", () => {
		const now = Date.now();
		const e1 = graph.addEntity("concept", "real-entity");

		// Manually insert a relationship pointing to a non-existent entity
		db.prepare(
			`INSERT INTO knowledge_relationships (id, source_id, target_id, type, strength, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("rel_broken", e1, "nonexistent_entity_id", "related_to", 0.5, now, now);

		insertMemory(db, { content_text: "real-entity test" });

		const report = lintMemory(db, graph);
		expect(report.broken.length).toBeGreaterThanOrEqual(1);
		const brokenReasons = report.broken.map((b) => b.reason);
		expect(brokenReasons).toContain("missing_target");
	});

	// ── Test 6: Detects consolidation gaps ────────────────────────────────

	it("detects consolidation gaps", () => {
		const fourteenDaysAgo = Date.now() - 14 * DAY_MS;

		insertMemory(db, {
			id: "old_raw",
			content_text: "raw memory that should have been consolidated",
			importance: 0.6,
			created_at: fourteenDaysAgo,
			consolidation_level: "raw",
		});

		const report = lintMemory(db, graph);
		expect(report.consolidationGaps).toBeGreaterThanOrEqual(1);
	});

	// ── Test 7: Score penalties accumulate ────────────────────────────────

	it("score penalties accumulate", () => {
		const now = Date.now();
		const sixtyDaysAgo = now - 60 * DAY_MS;

		// Orphan entity
		graph.addEntity("concept", "totallyorphaned");

		// Stale memories
		for (let i = 0; i < 5; i++) {
			insertMemory(db, {
				content_text: `stale memory number ${i}`,
				importance: 0.1,
				last_accessed: sixtyDaysAgo,
				created_at: sixtyDaysAgo,
			});
		}

		// Contradictory memories
		insertMemory(db, {
			content_text: "the app uses redis for caching data",
			importance: 0.8,
			created_at: now - 1000,
		});
		insertMemory(db, {
			content_text: "the app not uses redis for caching data",
			importance: 0.8,
			created_at: now,
		});

		const report = lintMemory(db, graph);

		// Also get a clean-ish baseline
		cleanup();
		const db2 = new Database(TEST_DB);
		createMemoriesTable(db2);
		const graph2 = new KnowledgeGraph(db2);
		const e1 = graph2.addEntity("concept", "clean");
		const e2 = graph2.addEntity("concept", "good");
		graph2.addRelationship(e1, e2, "related_to");
		insertMemory(db2, {
			content_text: "clean good memory",
			importance: 0.9,
			created_at: now,
			consolidation_level: "consolidated",
		});
		db2.prepare("INSERT INTO consolidation_log (id, created_at) VALUES (?, ?)").run("clog_1", now);
		const cleanReport = lintMemory(db2, graph2);
		db2.close();

		expect(report.score).toBeLessThan(cleanReport.score);
	});

	// ── Test 8: lintReportToMarkdown produces valid markdown ──────────────

	it("lintReportToMarkdown produces valid markdown", () => {
		const now = Date.now();

		// Set up some data so report has content
		graph.addEntity("concept", "orphanedthing");
		insertMemory(db, {
			content_text: "basic memory",
			importance: 0.5,
			created_at: now,
		});

		const report = lintMemory(db, graph);
		const md = lintReportToMarkdown(report);

		expect(md).toContain("# Memory Lint Report");
		expect(md).toContain("## Health Score:");
		expect(md).toContain("## Summary");
		expect(md).toContain("| Metric | Value |");
		expect(md).toContain("| Total Memories |");
	});
});
