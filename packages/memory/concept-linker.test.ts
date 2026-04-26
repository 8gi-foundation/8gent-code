/**
 * Tests for ConceptLinker — auto-links memory entities to concept entities
 * by matching concept names in content text using word-boundary regex.
 *
 * Covers:
 * 1. Links a memory to a matching concept
 * 2. Does NOT link on substring match (word boundary enforcement)
 * 3. Case-insensitive matching
 * 4. Links to multiple concepts in one pass
 * 5. Returns empty array when no concepts match
 * 6. Returns empty array when no concepts exist in graph
 * 7. Does not create duplicate links on repeated calls
 * 8. Handles special regex chars in concept names (e.g. "C++", "node.js")
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { ConceptLinker } from "./concept-linker.js";
import { KnowledgeGraph } from "./graph.js";

const TEST_DB = "/tmp/test-concept-linker-1368.db";

let db: Database;
let graph: KnowledgeGraph;
let linker: ConceptLinker;

function cleanup() {
	for (const suffix of ["", "-wal", "-shm"]) {
		const p = TEST_DB + suffix;
		if (existsSync(p)) unlinkSync(p);
	}
}

describe("ConceptLinker", () => {
	beforeEach(() => {
		cleanup();
		db = new Database(TEST_DB);
		graph = new KnowledgeGraph(db);
		linker = new ConceptLinker(graph);
	});

	afterEach(() => {
		db.close();
		cleanup();
	});

	// ── Test 1: Links a memory to a matching concept ─────────────────────

	it("links a memory to a matching concept", () => {
		const conceptId = graph.addEntity("concept", "authentication");
		const memoryId = graph.addEntity("file", "auth-module");

		const linked = linker.linkMemoryToConcepts(
			memoryId,
			"the authentication module needs work",
		);

		expect(linked).toEqual([conceptId]);

		const rels = graph.getRelationships(memoryId, "outgoing");
		expect(rels).toHaveLength(1);
		expect(rels[0].targetId).toBe(conceptId);
		expect(rels[0].type).toBe("related_to");
	});

	// ── Test 2: Does NOT link on substring match (word boundary) ─────────

	it("does not link on substring match — word boundary enforced", () => {
		graph.addEntity("concept", "auth");
		const memoryId = graph.addEntity("file", "auth-module");

		const linked = linker.linkMemoryToConcepts(
			memoryId,
			"the authentication module needs work",
		);

		expect(linked).toEqual([]);

		const rels = graph.getRelationships(memoryId, "outgoing");
		expect(rels).toHaveLength(0);
	});

	// ── Test 3: Case-insensitive matching ────────────────────────────────

	it("matches concepts case-insensitively", () => {
		const conceptId = graph.addEntity("concept", "Docker");
		const memoryId = graph.addEntity("file", "infra-notes");

		const linked = linker.linkMemoryToConcepts(
			memoryId,
			"docker containers are running fine",
		);

		expect(linked).toEqual([conceptId]);
	});

	// ── Test 4: Links to multiple concepts in one pass ───────────────────

	it("links to multiple concepts in one pass", () => {
		const c1 = graph.addEntity("concept", "caching");
		const c2 = graph.addEntity("concept", "redis");
		graph.addEntity("concept", "postgres"); // should NOT match
		const memoryId = graph.addEntity("file", "cache-layer");

		const linked = linker.linkMemoryToConcepts(
			memoryId,
			"we use redis for caching session tokens",
		);

		expect(linked).toHaveLength(2);
		expect(linked).toContain(c1);
		expect(linked).toContain(c2);
	});

	// ── Test 5: Returns empty array when no concepts match ───────────────

	it("returns empty array when no concepts match", () => {
		graph.addEntity("concept", "kubernetes");
		graph.addEntity("concept", "terraform");
		const memoryId = graph.addEntity("file", "readme");

		const linked = linker.linkMemoryToConcepts(
			memoryId,
			"this is about the database schema",
		);

		expect(linked).toEqual([]);
	});

	// ── Test 6: Returns empty array when no concepts exist ───────────────

	it("returns empty array when no concepts exist in graph", () => {
		const memoryId = graph.addEntity("file", "something");

		const linked = linker.linkMemoryToConcepts(
			memoryId,
			"authentication and caching are important",
		);

		expect(linked).toEqual([]);
	});

	// ── Test 7: No duplicate links on repeated calls ─────────────────────

	it("does not create duplicate links on repeated calls", () => {
		const conceptId = graph.addEntity("concept", "authentication");
		const memoryId = graph.addEntity("file", "auth-module");

		linker.linkMemoryToConcepts(memoryId, "authentication module");
		linker.linkMemoryToConcepts(memoryId, "authentication module");

		const rels = graph.getRelationships(memoryId, "outgoing");
		const relatedToRels = rels.filter(
			(r) => r.targetId === conceptId && r.type === "related_to",
		);
		expect(relatedToRels).toHaveLength(1);
	});

	// ── Test 8: Handles special regex chars in concept names ─────────────

	it("handles special regex chars in concept names like C++ and node.js", () => {
		const cppId = graph.addEntity("concept", "C++");
		const nodeId = graph.addEntity("concept", "node.js");
		const memoryId = graph.addEntity("file", "languages-doc");

		const linked = linker.linkMemoryToConcepts(
			memoryId,
			"we support C++ and node.js in our stack",
		);

		expect(linked).toHaveLength(2);
		expect(linked).toContain(cppId);
		expect(linked).toContain(nodeId);
	});
});
