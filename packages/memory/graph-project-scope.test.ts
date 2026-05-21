/**
 * Tests for project scoping in KnowledgeGraph.
 *
 * Covers:
 * 1. Same (type, name) in different projects are SEPARATE entities.
 * 2. Same (type, name) in the SAME project dedupes (one row, mentionCount bumps).
 * 3. findEntities / getStats are project-scoped.
 * 4. query() is project-scoped.
 * 5. addRelationship dedupes per project.
 * 6. Migration: a DB created with the OLD unscoped schema gains project_id,
 *    every pre-existing row backfills to 'default', and no data is lost.
 *
 * Sibling of entity-dedup.test.ts. Issue: graph.* RPC project scoping.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { KnowledgeGraph } from "./graph.js";

const TEST_DB = "/tmp/test-graph-project-scope.db";
const MIGRATE_DB = "/tmp/test-graph-migrate.db";

function rm(p: string): void {
	if (existsSync(p)) unlinkSync(p);
}

describe("KnowledgeGraph project scoping", () => {
	let db: Database;
	let graph: KnowledgeGraph;

	beforeEach(() => {
		rm(TEST_DB);
		db = new Database(TEST_DB);
		graph = new KnowledgeGraph(db);
	});

	afterEach(() => {
		db.close();
		rm(TEST_DB);
	});

	it("keeps same-identity entities in different projects separate", () => {
		const a = graph.addEntity("concept", "Router", undefined, "project-a");
		const b = graph.addEntity("concept", "Router", undefined, "project-b");
		expect(a).not.toBe(b);

		const ea = graph.getEntity(a);
		const eb = graph.getEntity(b);
		expect(ea?.projectId).toBe("project-a");
		expect(eb?.projectId).toBe("project-b");
		expect(ea?.mentionCount).toBe(1);
		expect(eb?.mentionCount).toBe(1);
	});

	it("dedupes same (type, name) within the same project", () => {
		const id1 = graph.addEntity("concept", "Router", undefined, "project-a");
		const id2 = graph.addEntity("concept", "Router", undefined, "project-a");
		expect(id1).toBe(id2);
		const e = graph.getEntity(id1);
		expect(e?.mentionCount).toBe(2);
	});

	it("defaults to the 'default' project when projectId omitted", () => {
		const id = graph.addEntity("tool", "bun");
		expect(graph.getEntity(id)?.projectId).toBe("default");
		// A 'default'-scoped explicit call dedupes against the implicit one.
		const id2 = graph.addEntity("tool", "bun", undefined, "default");
		expect(id2).toBe(id);
		expect(graph.getEntity(id)?.mentionCount).toBe(2);
	});

	it("findEntities is project-scoped", () => {
		graph.addEntity("concept", "Shared", undefined, "project-a");
		graph.addEntity("concept", "Shared", undefined, "project-b");
		graph.addEntity("concept", "OnlyA", undefined, "project-a");

		const a = graph.findEntities({ projectId: "project-a" });
		const b = graph.findEntities({ projectId: "project-b" });
		expect(a.map((e) => e.name).sort()).toEqual(["OnlyA", "Shared"]);
		expect(b.map((e) => e.name).sort()).toEqual(["Shared"]);
	});

	it("getStats is project-scoped", () => {
		graph.addEntity("concept", "A", undefined, "project-a");
		graph.addEntity("function", "B", undefined, "project-a");
		graph.addEntity("concept", "C", undefined, "project-b");

		const a = graph.getStats("project-a");
		const b = graph.getStats("project-b");
		expect(a.entityCount).toBe(2);
		expect(b.entityCount).toBe(1);
		expect(a.byType).toEqual({ concept: 1, function: 1 });
		expect(b.byType).toEqual({ concept: 1 });
	});

	it("query is project-scoped", () => {
		graph.addEntity("concept", "Alpha", undefined, "project-a");
		graph.addEntity("concept", "Alpha", undefined, "project-b");

		const a = graph.query({ entityType: "concept" }, "project-a");
		const b = graph.query({ entityType: "concept" }, "project-b");
		expect(a.entities).toHaveLength(1);
		expect(b.entities).toHaveLength(1);
		expect(a.entities[0].projectId).toBe("project-a");
		expect(b.entities[0].projectId).toBe("project-b");
	});

	it("addRelationship dedupes per project", () => {
		const sa = graph.addEntity("concept", "S", undefined, "project-a");
		const ta = graph.addEntity("concept", "T", undefined, "project-a");
		const r1 = graph.addRelationship(sa, ta, "related_to", undefined, "project-a");
		const r2 = graph.addRelationship(sa, ta, "related_to", undefined, "project-a");
		expect(r1).toBe(r2);
		expect(graph.getStats("project-a").relationshipCount).toBe(1);
	});
});

describe("KnowledgeGraph migration from unscoped schema", () => {
	afterEach(() => {
		rm(MIGRATE_DB);
	});

	it("adds project_id to a populated pre-scoping DB and backfills 'default'", () => {
		// Build a DB with the OLD unscoped schema and seed two entities + one
		// relationship, exactly as a pre-feature daemon would have left it.
		const raw = new Database(MIGRATE_DB);
		raw.run(`
			CREATE TABLE knowledge_entities (
				id            TEXT PRIMARY KEY,
				type          TEXT NOT NULL,
				name          TEXT NOT NULL,
				description   TEXT,
				metadata      TEXT,
				first_seen    INTEGER NOT NULL,
				last_seen     INTEGER NOT NULL,
				mention_count INTEGER NOT NULL DEFAULT 1,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL,
				UNIQUE(type, name)
			)
		`);
		raw.run(`
			CREATE TABLE knowledge_relationships (
				id            TEXT PRIMARY KEY,
				source_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
				target_id     TEXT NOT NULL REFERENCES knowledge_entities(id),
				type          TEXT NOT NULL,
				strength      REAL NOT NULL DEFAULT 0.5,
				metadata      TEXT,
				created_at    INTEGER NOT NULL,
				updated_at    INTEGER NOT NULL,
				UNIQUE(source_id, target_id, type)
			)
		`);
		const now = Date.now();
		raw.run(
			"INSERT INTO knowledge_entities (id, type, name, description, metadata, first_seen, last_seen, mention_count, created_at, updated_at) VALUES ('ent_old_1', 'concept', 'Legacy', NULL, NULL, ?, ?, 3, ?, ?)",
			[now, now, now, now],
		);
		raw.run(
			"INSERT INTO knowledge_entities (id, type, name, description, metadata, first_seen, last_seen, mention_count, created_at, updated_at) VALUES ('ent_old_2', 'function', 'oldFn', NULL, NULL, ?, ?, 1, ?, ?)",
			[now, now, now, now],
		);
		raw.run(
			"INSERT INTO knowledge_relationships (id, source_id, target_id, type, strength, metadata, created_at, updated_at) VALUES ('rel_old_1', 'ent_old_1', 'ent_old_2', 'related_to', 0.7, NULL, ?, ?)",
			[now, now],
		);
		raw.close();

		// Open through KnowledgeGraph: initSchema runs the migration.
		const db = new Database(MIGRATE_DB);
		const graph = new KnowledgeGraph(db);

		// No data lost: both entities + the relationship survive.
		const legacy = graph.getEntity("ent_old_1");
		const oldFn = graph.getEntity("ent_old_2");
		expect(legacy?.name).toBe("Legacy");
		expect(legacy?.mentionCount).toBe(3);
		expect(oldFn?.name).toBe("oldFn");

		// Every pre-existing row backfilled to the 'default' project.
		expect(legacy?.projectId).toBe("default");
		expect(oldFn?.projectId).toBe("default");

		const stats = graph.getStats("default");
		expect(stats.entityCount).toBe(2);
		expect(stats.relationshipCount).toBe(1);

		const rels = graph.getRelationships("ent_old_1", "outgoing");
		expect(rels).toHaveLength(1);
		expect(rels[0].projectId).toBe("default");
		expect(rels[0].strength).toBe(0.7);

		// Post-migration writes still dedupe within the default project and
		// stay separate from a new project.
		const sameDefault = graph.addEntity("concept", "Legacy");
		expect(sameDefault).toBe("ent_old_1");
		const otherProject = graph.addEntity("concept", "Legacy", undefined, "project-x");
		expect(otherProject).not.toBe("ent_old_1");

		db.close();
	});

	it("re-opening an already-migrated DB is a no-op (idempotent)", () => {
		// First open creates + migrates.
		let db = new Database(MIGRATE_DB);
		let graph = new KnowledgeGraph(db);
		graph.addEntity("concept", "Persisted", undefined, "project-a");
		db.close();

		// Second open must not throw and must preserve the data.
		db = new Database(MIGRATE_DB);
		graph = new KnowledgeGraph(db);
		const found = graph.findEntities({ projectId: "project-a" });
		expect(found).toHaveLength(1);
		expect(found[0].name).toBe("Persisted");
		db.close();
	});
});
