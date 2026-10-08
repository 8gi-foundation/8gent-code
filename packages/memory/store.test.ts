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

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { MemoryStore } from "./store.js";
import { type CoreMemory, type Memory, type SemanticMemory, generateId } from "./types.js";

const TEST_DB = `/tmp/memory-store-test-${Date.now()}.db`;

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

function makeSemanticMemory(overrides: Partial<SemanticMemory> = {}): SemanticMemory {
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
		expect(retrieved?.type).toBe("core");
		expect((retrieved as CoreMemory).content).toBe("Architecture uses microservices");
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
		expect(retrieved?.type).toBe("core");
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
		expect(retrieved?.type).toBe("core");
		expect((retrieved as CoreMemory).title).toBe(mem.title);
	});

	// ── Test 6: update() doesn't double-encode merged data ─────────────

	it("update() does not double-encode the merged memory", () => {
		const mem = makeCoreMemory({
			content: "original content",
		});

		const id = store.write(mem);

		store.update(id, { content: "updated content" } as Partial<Memory>, "test update", "test-user");

		const retrieved = store.get(id) as CoreMemory;
		expect(retrieved).not.toBeNull();
		expect(retrieved.content).toBe("updated content");
		expect(typeof retrieved.content).toBe("string");
		expect(retrieved.type).toBe("core");
		expect(typeof retrieved.importance).toBe("number");
		expect(Array.isArray(retrieved.tags)).toBe(true);

		// Update again to verify no accumulation of encoding
		store.update(id, { content: "second update" } as Partial<Memory>, "second update", "test-user");
		const retrieved2 = store.get(id) as CoreMemory;
		expect(retrieved2.content).toBe("second update");
		expect(retrieved2.version).toBe(3);
	});
});

// ── FTS5 query building (#3537) ──────────────────────────────────────
//
// _ftsSearch used to pass bare FTS5 operators (AND, NOT, NEAR) straight into
// MATCH, where they became syntax errors swallowed as [], and stripped every
// non-ASCII letter, so "Éire" was queried as "ire*" against an index that
// unicode61 had folded to "eire". These cases run the shipping _ftsSearch on
// an in-memory store built by MemoryStore itself (same schema, same tokenizer).

const FTS_CORPUS: Array<[string, string]> = [
	["fts-01", "Git hooks: the pre-commit hook runs biome before every commit"],
	["fts-02", "Hook ordering: what runs first, the hook or the formatter"],
	["fts-03", "Cats: James does not like cats in the office"],
	["fts-04", "Dogs and walks: dogs need a walk after lunch"],
	["fts-05", "State name: Éire is the name of the state in its own language"],
	["fts-06", "Follow-up: send the follow-up email to the board on Friday"],
	["fts-07", "Commit style: never commit without running the pre-commit checks"],
	["fts-08", "Contractions: don't use em dashes, don't pad stats"],
	["fts-09", "Identifiers: the foo_bar helper lives in the utils package"],
	["fts-10", "Coffee: the café on the corner opens at eight"],
	["fts-11", "Preferences: James prefers short commit messages"],
	["fts-12", "Email triage: answer email from the board within a day"],
	["fts-13", "Deploy: the daemon deploys to Fly.io in Amsterdam"],
	["fts-14", "Memory store: SQLite with FTS5 and a porter stemmer"],
	["fts-15", "Walking: a long walk with the dogs clears the head"],
	["fts-16", "Formatter: biome formats TypeScript before the commit lands"],
];

/** The pre-#3537 query builder, kept as the oracle for "same rows, same order". */
function legacyFtsQuery(query: string): string {
	return query
		.replace(/[^\w\s]/g, "")
		.split(/\s+/)
		.filter((t) => t.length > 2)
		.map((t) => `${t}*`)
		.join(" OR ");
}

describe("FTS5 query building (#3537)", () => {
	let ftsStore: MemoryStore;

	const ftsIds = (query: string): string[] =>
		(
			ftsStore as unknown as {
				_ftsSearch(q: string, o: { limit: number }): Array<{ memory: Memory }>;
			}
		)
			._ftsSearch(query, { limit: 50 })
			.map((r) => r.memory.id);

	const legacyIds = (query: string): string[] => {
		const q = legacyFtsQuery(query);
		if (!q) return [];
		return (
			ftsStore
				.getDb()
				.prepare(
					`SELECT m.id FROM memories_fts fts JOIN memories m ON m.rowid = fts.rowid
           WHERE memories_fts MATCH ? AND m.deleted_at IS NULL ORDER BY rank LIMIT 100`,
				)
				.all(q) as Array<{ id: string }>
		).map((r) => r.id);
	};

	beforeEach(() => {
		ftsStore = new MemoryStore(":memory:");
		for (const [id, text] of FTS_CORPUS) {
			const [title, content] = text.split(": ");
			ftsStore.write(makeCoreMemory({ id, key: id, title, content, tags: [] }));
		}
	});

	afterEach(() => {
		ftsStore.close();
	});

	it("treats a bare AND as a word, not an operator", () => {
		const ids = ftsIds("what AND hook");
		expect(ids).toContain("fts-02");
		expect(ids).toContain("fts-01");
	});

	it("treats a leading NOT as a word, not an operator", () => {
		const ids = ftsIds("NOT cats");
		expect(ids).toContain("fts-03");
	});

	it("survives a trailing AND", () => {
		const ids = ftsIds("dogs AND");
		expect(ids).toContain("fts-04");
		expect(ids).toContain("fts-15");
	});

	it("matches accented words against the diacritic-folded index", () => {
		expect(ftsIds("Éire")).toEqual(["fts-05"]);
	});

	const PLAIN_QUERIES = [
		"pre-commit hook",
		"follow-up email",
		"don't",
		"foo_bar",
		"café",
		"commit messages",
		"dogs walk",
		"board email Friday",
		"biome formatter",
		"state language",
		"daemon deploy Amsterdam",
		"SQLite porter stemmer",
		"James prefers",
		"the corner",
		"hooks",
	];

	// unicode61 splits "don't" into "don" + "t", so the stripped token "dont"
	// matched nothing before and must still match nothing.
	const KNOWN_EMPTY = new Set(["don't"]);

	for (const query of PLAIN_QUERIES) {
		it(`keeps plain query "${query}" on the same rows in the same order`, () => {
			const before = legacyIds(query);
			if (!KNOWN_EMPTY.has(query)) expect(before.length).toBeGreaterThan(0);
			expect(ftsIds(query)).toEqual(before);
		});
	}
});
