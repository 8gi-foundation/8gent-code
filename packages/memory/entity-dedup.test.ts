/**
 * Tests for entity dedup via UNIQUE(type, name) composite key.
 *
 * Covers:
 * 1. addEntity with same (type, name) returns existing ID (not a new one)
 * 2. addEntity with same name but different type creates separate entities
 * 3. Duplicate addEntity bumps mention_count to 3 after 3 calls
 * 4. Duplicate addEntity merges metadata
 * 5. Duplicate addEntity updates description if provided
 * 6. UNIQUE constraint prevents raw INSERT duplicates
 * 7. Rapid-fire 10 calls produce exactly 1 entity with mentionCount=10
 *
 * Issue: #1369
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeGraph } from "./graph.js";
import type { EntityType } from "./graph.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/test-entity-dedup-1369.db";

describe("Entity dedup -- KnowledgeGraph", () => {
	let db: Database;
	let graph: KnowledgeGraph;

	beforeEach(() => {
		// Clean slate for every test
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
		db = new Database(TEST_DB);
		graph = new KnowledgeGraph(db);
	});

	afterEach(() => {
		db.close();
		if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
	});

	// -- Test 1: same (type, name) returns existing ID -------------------------

	it("returns the same ID when adding the same (type, name) twice", () => {
		const id1 = graph.addEntity("person", "Alice");
		const id2 = graph.addEntity("person", "Alice");
		expect(id1).toBe(id2);
	});

	// -- Test 2: same name, different type => separate entities -----------------

	it("creates separate entities for same name but different type", () => {
		const personId = graph.addEntity("person", "Logger");
		const packageId = graph.addEntity("package", "Logger");
		expect(personId).not.toBe(packageId);

		const person = graph.getEntity(personId);
		const pkg = graph.getEntity(packageId);
		expect(person?.type).toBe("person");
		expect(pkg?.type).toBe("package");
	});

	// -- Test 3: mention_count increments correctly -----------------------------

	it("bumps mention_count to 3 after three addEntity calls", () => {
		const id = graph.addEntity("concept", "TDD");
		graph.addEntity("concept", "TDD");
		graph.addEntity("concept", "TDD");

		const entity = graph.getEntity(id);
		expect(entity).not.toBeNull();
		expect(entity!.mentionCount).toBe(3);
	});

	// -- Test 4: metadata merges on duplicate -----------------------------------

	it("merges metadata on duplicate addEntity", () => {
		const id = graph.addEntity("tool", "bun", {
			metadata: { version: "1.0" },
		});

		graph.addEntity("tool", "bun", {
			metadata: { runtime: "js" },
		});

		const entity = graph.getEntity(id);
		expect(entity).not.toBeNull();
		expect(entity!.metadata).toEqual({ version: "1.0", runtime: "js" });
	});

	// -- Test 5: description updates on duplicate -------------------------------

	it("updates description if provided on duplicate addEntity", () => {
		const id = graph.addEntity("decision", "Use SQLite", {
			description: "Initial choice",
		});

		graph.addEntity("decision", "Use SQLite", {
			description: "Confirmed after benchmarks",
		});

		const entity = graph.getEntity(id);
		expect(entity).not.toBeNull();
		expect(entity!.description).toBe("Confirmed after benchmarks");
	});

	// -- Test 6: UNIQUE constraint at DB level ----------------------------------

	it("UNIQUE constraint prevents raw INSERT duplicates", () => {
		graph.addEntity("person", "Bob");

		expect(() => {
			db.run(
				"INSERT INTO knowledge_entities (id, type, name, description, metadata, first_seen, last_seen, mention_count, created_at, updated_at) VALUES ('ent_raw_test', 'person', 'Bob', NULL, NULL, 0, 0, 1, 0, 0)",
			);
		}).toThrow();
	});

	// -- Test 7: rapid-fire 10 calls => 1 entity, mentionCount=10 --------------

	it("rapid-fire 10 addEntity calls produce exactly 1 entity with mentionCount=10", () => {
		let lastId = "";
		for (let i = 0; i < 10; i++) {
			lastId = graph.addEntity("function", "handleRequest");
		}

		const entities = graph.findEntities({
			type: "function",
			name: "handleRequest",
		});
		expect(entities).toHaveLength(1);
		expect(entities[0].id).toBe(lastId);
		expect(entities[0].mentionCount).toBe(10);
	});
});
