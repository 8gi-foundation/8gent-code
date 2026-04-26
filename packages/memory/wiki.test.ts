/**
 * Tests for WikiGenerator — transforms knowledge graph + memories into
 * interlinked markdown wiki pages.
 *
 * Covers:
 * 1. generateEntityPage returns valid WikiPage with correct frontmatter
 * 2. generateEntityPage includes related entities as markdown links
 * 3. generateEntityPage includes backlinks section for incoming relationships
 * 4. generateEntityPage returns null for non-existent entity
 * 5. generateAllPages returns a page for every entity
 * 6. generateIndex groups entities by type
 * 7. slugify handles special characters, spaces, and case
 * 8. writeToDirectory creates files on disk
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { KnowledgeGraph } from "./graph.js";
import { WikiGenerator, slugify } from "./wiki.js";

const TEST_DB = "/tmp/test-wiki-generator.db";
const TEST_OUT = "/tmp/test-wiki-out";

let db: Database;
let graph: KnowledgeGraph;
let wiki: WikiGenerator;

// Entity IDs populated in beforeEach
let personAlice: string;
let personBob: string;
let conceptAuth: string;
let conceptCache: string;
let serviceRedis: string;

function cleanupDb() {
	for (const suffix of ["", "-wal", "-shm"]) {
		const p = TEST_DB + suffix;
		if (existsSync(p)) unlinkSync(p);
	}
}

function cleanupOut() {
	if (existsSync(TEST_OUT)) {
		rmSync(TEST_OUT, { recursive: true, force: true });
	}
}

/** Create the memories table (subset of store schema needed for wiki queries). */
function createMemoriesTable(database: Database) {
	database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      scope         TEXT NOT NULL,
      data          TEXT NOT NULL,
      content_text  TEXT NOT NULL,
      tags          TEXT,
      importance    REAL NOT NULL DEFAULT 0.5,
      decay_factor  REAL NOT NULL DEFAULT 1.0,
      access_count  INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER,
      confidence    REAL,
      evidence_count INTEGER DEFAULT 0,
      version       INTEGER NOT NULL DEFAULT 1,
      source        TEXT NOT NULL,
      source_id     TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      deleted_at    INTEGER
    )
  `);

	database.exec(`
    CREATE TABLE IF NOT EXISTS consolidation_log (
      id            TEXT PRIMARY KEY,
      level         TEXT NOT NULL,
      source_ids    TEXT NOT NULL,
      result_id     TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      error         TEXT,
      started_at    INTEGER,
      completed_at  INTEGER,
      created_at    INTEGER NOT NULL
    )
  `);
}

function insertMemory(
	database: Database,
	id: string,
	contentText: string,
	importance: number,
) {
	const now = Date.now();
	database
		.prepare(
			`INSERT INTO memories (id, type, scope, data, content_text, tags, importance, source, created_at, updated_at)
       VALUES (?, 'semantic', 'project', '{}', ?, '[]', ?, 'extraction', ?, ?)`,
		)
		.run(id, contentText, importance, now, now);
}

describe("WikiGenerator", () => {
	beforeEach(() => {
		cleanupDb();
		cleanupOut();
		db = new Database(TEST_DB);
		graph = new KnowledgeGraph(db);
		createMemoriesTable(db);
		wiki = new WikiGenerator(db, graph);

		// Seed entities
		personAlice = graph.addEntity("person", "Alice", {
			description: "Lead engineer",
		});
		personBob = graph.addEntity("person", "Bob", {
			description: "Backend developer",
		});
		conceptAuth = graph.addEntity("concept", "Authentication", {
			description: "User identity verification",
		});
		conceptCache = graph.addEntity("concept", "Caching");
		serviceRedis = graph.addEntity("tool", "Redis", {
			description: "In-memory data store",
		});

		// Relationships
		graph.addRelationship(personAlice, conceptAuth, "decided");
		graph.addRelationship(personBob, serviceRedis, "uses");
		graph.addRelationship(serviceRedis, conceptCache, "implements");
		graph.addRelationship(conceptAuth, personAlice, "related_to"); // backlink test

		// Seed some memories
		insertMemory(
			db,
			"mem_001",
			"Alice designed the Authentication flow using JWT tokens",
			0.9,
		);
		insertMemory(db, "mem_002", "Redis is used for Caching session data", 0.7);
		insertMemory(db, "mem_003", "Bob optimized the Redis connection pool", 0.6);
	});

	afterEach(() => {
		db.close();
		cleanupDb();
		cleanupOut();
	});

	// ── Test 1 ─────────────────────────────────────────────────────────

	it("generateEntityPage returns valid WikiPage with correct frontmatter", () => {
		const page = wiki.generateEntityPage(personAlice);

		expect(page).not.toBeNull();
		expect(page!.slug).toBe("alice");
		expect(page!.title).toBe("Alice");
		expect(page!.entityId).toBe(personAlice);
		expect(page!.entityType).toBe("person");

		// Frontmatter fields
		expect(page!.frontmatter.type).toBe("person");
		expect(page!.frontmatter.name).toBe("Alice");
		expect(page!.frontmatter.mentionCount).toBeGreaterThanOrEqual(1);
		expect(typeof page!.frontmatter.firstSeen).toBe("string");
		expect(typeof page!.frontmatter.importance).toBe("number");

		// Markdown contains YAML block
		expect(page!.markdown).toContain("---");
		expect(page!.markdown).toContain("# Alice");
		expect(page!.markdown).toContain("**Type:** person");
	});

	// ── Test 2 ─────────────────────────────────────────────────────────

	it("generateEntityPage includes related entities as markdown links", () => {
		const page = wiki.generateEntityPage(personAlice);

		expect(page).not.toBeNull();
		expect(page!.markdown).toContain("## Related Entities");
		expect(page!.markdown).toContain("[Authentication](authentication.md)");
	});

	// ── Test 3 ─────────────────────────────────────────────────────────

	it("generateEntityPage includes backlinks section for incoming relationships", () => {
		// conceptAuth has an incoming relationship from personAlice (decided)
		const page = wiki.generateEntityPage(conceptAuth);

		expect(page).not.toBeNull();
		expect(page!.markdown).toContain("## Backlinks");
		expect(page!.markdown).toContain("[Alice](alice.md)");
	});

	// ── Test 4 ─────────────────────────────────────────────────────────

	it("generateEntityPage returns null for non-existent entity", () => {
		const page = wiki.generateEntityPage("ent_nonexistent999999");
		expect(page).toBeNull();
	});

	// ── Test 5 ─────────────────────────────────────────────────────────

	it("generateAllPages returns a page for every entity", () => {
		const pages = wiki.generateAllPages();
		// We created 5 entities in beforeEach
		expect(pages).toHaveLength(5);

		const slugs = pages.map((p) => p.slug);
		expect(slugs).toContain("alice");
		expect(slugs).toContain("bob");
		expect(slugs).toContain("authentication");
		expect(slugs).toContain("caching");
		expect(slugs).toContain("redis");
	});

	// ── Test 6 ─────────────────────────────────────────────────────────

	it("generateIndex groups entities by type", () => {
		const index = wiki.generateIndex();

		// Should have entries for all 5 entities
		expect(index.pages).toHaveLength(5);

		// Markdown should have type headings
		expect(index.markdown).toContain("## person");
		expect(index.markdown).toContain("## concept");
		expect(index.markdown).toContain("## tool");

		// Links present
		expect(index.markdown).toContain("[Alice](alice.md)");
		expect(index.markdown).toContain("[Redis](redis.md)");
	});

	// ── Test 7 ─────────────────────────────────────────────────────────

	it("slugify handles special characters, spaces, and case", () => {
		expect(slugify("Hello World")).toBe("hello-world");
		expect(slugify("C++")).toBe("c");
		expect(slugify("node.js")).toBe("node-js");
		expect(slugify("  Leading/Trailing  ")).toBe("leading-trailing");
		expect(slugify("multiple---hyphens")).toBe("multiple-hyphens");
		expect(slugify("UPPER_CASE_NAME")).toBe("upper-case-name");
		expect(slugify("foo@bar#baz")).toBe("foo-bar-baz");
	});

	// ── Test 8 ─────────────────────────────────────────────────────────

	it("writeToDirectory creates files on disk", () => {
		const result = wiki.writeToDirectory(TEST_OUT);

		expect(result.pagesWritten).toBe(5);
		expect(result.indexWritten).toBe(true);

		// Verify files exist
		expect(existsSync(`${TEST_OUT}/index.md`)).toBe(true);
		expect(existsSync(`${TEST_OUT}/log.md`)).toBe(true);
		expect(existsSync(`${TEST_OUT}/alice.md`)).toBe(true);
		expect(existsSync(`${TEST_OUT}/redis.md`)).toBe(true);

		// Verify content is non-empty markdown
		const indexContent = readFileSync(`${TEST_OUT}/index.md`, "utf-8");
		expect(indexContent).toContain("# Wiki Index");

		const aliceContent = readFileSync(`${TEST_OUT}/alice.md`, "utf-8");
		expect(aliceContent).toContain("# Alice");
	});
});
