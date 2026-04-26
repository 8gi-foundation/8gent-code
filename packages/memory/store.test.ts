/**
 * Tests for JSONB double-encoding guard in MemoryStore.
 *
 * Covers:
 * 1. Roundtrip memory with object metadata — no double-encoding
 * 2. Roundtrip memory with pre-serialized JSON string in content
 * 3. Heal existing double-encoded data on read
 * 4. Don't corrupt valid non-JSON string values
 * 5. Handle nested double-encoding (2 levels deep)
 * 6. update() doesn't double-encode merged data
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import {
	type CoreMemory,
	type SemanticMemory,
	type Memory,
	generateId,
} from "./types.js";
import { existsSync, unlinkSync } from "node:fs";

const TEST_DB = "/tmp/memory-store-test-" + Date.now() + ".db";

function makeCoreMemory(overrides: Partial<CoreMemory> = {}): CoreMemory {
	const now = Date.now();
	return {
		id: generateId("mem"),
		type: "core",
		scope: "project",
		category: "architecture",
		key: "test-key",
		title: "Test Memory",
		content: "Some content",
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

function makeSemanticMemory(
	overrides: Partial<SemanticMemory> = {},
): SemanticMemory {
	const now = Date.now();
	return {
		id: generateId("mem"),
		type: "semantic",
		scope: "project",
		category: "fact",
		key: "test-fact",
		value: "some value",
		confidence: 0.8,
		evidenceCount: 1,
		tags: ["test"],
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
		source: "user_explicit",
		...overrides,
	};
}

let store: MemoryStore;

describe("JSONB double-encoding guard", () => {
	beforeEach(() => {
		store = new MemoryStore(TEST_DB);
	});

	afterEach(() => {
		store.close();
		for (const suffix of ["", "-wal", "-shm"]) {
			const p = TEST_DB + suffix;
			if (existsSync(p)) unlinkSync(p);
		}
	});

	// ── Test 1: Roundtrip with object metadata — no double-encoding ────

	it("roundtrips memory with object content without double-encoding", () => {
		const mem = makeCoreMemory({
			content: "Architecture uses microservices",
			tags: ["arch", "design"],
		});

		const id = store.write(mem);
		const retrieved = store.get(id);

		expect(retrieved).not.toBeNull();
		expect(retrieved!.type).toBe("core");
		expect((retrieved as CoreMemory).content).toBe(
			"Architecture uses microservices",
		);
		expect((retrieved as CoreMemory).tags).toEqual(["arch", "design"]);
		expect(Array.isArray((retrieved as CoreMemory).tags)).toBe(true);
	});

	// ── Test 2: Roundtrip with pre-serialized JSON string in content ───

	it("roundtrips memory whose content is a pre-serialized JSON string", () => {
		const innerObj = { framework: "React", version: "18.2" };
		const mem = makeCoreMemory({
			content: JSON.stringify(innerObj),
		});

		const id = store.write(mem);
		const retrieved = store.get(id) as CoreMemory;

		expect(retrieved).not.toBeNull();
		const parsed = JSON.parse(retrieved.content);
		expect(parsed).toEqual(innerObj);
	});

	// ── Test 3: Heal existing double-encoded data on read ──────────────

	it("heals double-encoded data on read", () => {
		const mem = makeCoreMemory();
		const id = mem.id;

		// Manually insert a double-encoded row: JSON.stringify applied TWICE
		const singleEncoded = JSON.stringify(mem);
		const doubleEncoded = JSON.stringify(singleEncoded);

		const db = store.getDb();
		const contentText = `${mem.title}: ${mem.content}`;
		const now = Date.now();

		db.prepare(`
      INSERT INTO memories (id, type, scope, data, content_text, tags, importance, decay_factor,
        access_count, last_accessed, confidence, evidence_count, version, source, source_id,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			id,
			mem.type,
			mem.scope,
			doubleEncoded,
			contentText,
			JSON.stringify(mem.tags),
			mem.importance,
			mem.decayFactor,
			mem.accessCount,
			mem.lastAccessed,
			mem.confidence,
			mem.evidenceCount,
			mem.version,
			mem.source,
			null,
			now,
			now,
		);

		const retrieved = store.get(id);
		expect(retrieved).not.toBeNull();
		expect(typeof retrieved).toBe("object");
		expect(retrieved!.type).toBe("core");
		expect((retrieved as CoreMemory).title).toBe(mem.title);
	});

	// ── Test 4: Don't corrupt valid non-JSON string values ─────────────

	it("does not corrupt plain string values like 'hello world'", () => {
		const mem = makeSemanticMemory({
			value: "hello world",
		});

		const id = store.write(mem);
		const retrieved = store.get(id) as SemanticMemory;

		expect(retrieved).not.toBeNull();
		expect(retrieved.value).toBe("hello world");
		expect(typeof retrieved.value).toBe("string");
	});

	// ── Test 5: Handle nested double-encoding (2 levels deep) ──────────

	it("handles 2 levels of double-encoding on read", () => {
		const mem = makeCoreMemory();
		const id = mem.id;

		// Triple-stringify: need to unwrap 2 extra layers
		const singleEncoded = JSON.stringify(mem);
		const doubleEncoded = JSON.stringify(singleEncoded);
		const tripleEncoded = JSON.stringify(doubleEncoded);

		const db = store.getDb();
		const contentText = `${mem.title}: ${mem.content}`;
		const now = Date.now();

		db.prepare(`
      INSERT INTO memories (id, type, scope, data, content_text, tags, importance, decay_factor,
        access_count, last_accessed, confidence, evidence_count, version, source, source_id,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			id,
			mem.type,
			mem.scope,
			tripleEncoded,
			contentText,
			JSON.stringify(mem.tags),
			mem.importance,
			mem.decayFactor,
			mem.accessCount,
			mem.lastAccessed,
			mem.confidence,
			mem.evidenceCount,
			mem.version,
			mem.source,
			null,
			now,
			now,
		);

		const retrieved = store.get(id);
		expect(retrieved).not.toBeNull();
		expect(typeof retrieved).toBe("object");
		expect(retrieved!.type).toBe("core");
		expect((retrieved as CoreMemory).title).toBe(mem.title);
	});

	// ── Test 6: update() doesn't double-encode merged data ─────────────

	it("update() does not double-encode the merged memory", () => {
		const mem = makeCoreMemory({
			content: "original content",
		});

		const id = store.write(mem);

		store.update(
			id,
			{ content: "updated content" } as Partial<Memory>,
			"test update",
			"test-user",
		);

		const retrieved = store.get(id) as CoreMemory;
		expect(retrieved).not.toBeNull();
		expect(retrieved.content).toBe("updated content");
		expect(typeof retrieved.content).toBe("string");
		expect(retrieved.type).toBe("core");
		expect(typeof retrieved.importance).toBe("number");
		expect(Array.isArray(retrieved.tags)).toBe(true);

		// Update again to verify no accumulation of encoding
		store.update(
			id,
			{ content: "second update" } as Partial<Memory>,
			"second update",
			"test-user",
		);
		const retrieved2 = store.get(id) as CoreMemory;
		expect(retrieved2.content).toBe("second update");
		expect(retrieved2.version).toBe(3);
	});
});
