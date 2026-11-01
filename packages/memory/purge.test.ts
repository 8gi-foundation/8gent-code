/**
 * C-M5 and attack M2/M3 (epic #4391): purge is a true delete, proven by counts and by raw bytes.
 * Synthetic people only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.js";
import type { EpisodicMemory } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function row(userId: string, content: string): EpisodicMemory {
	const now = Date.now();
	return {
		id: "",
		type: "episodic",
		scope: "global",
		userId,
		content,
		context: "t",
		tags: ["t"],
		entities: [],
		occurredAt: now,
		importance: 0.5,
		decayFactor: 1,
		accessCount: 0,
		lastAccessed: now,
		createdAt: now,
		updatedAt: now,
		version: 1,
		source: "conversation",
	};
}

/** 30 rows per person; every third forgotten (so a version snapshot exists); embeddings, entities, edges. */
function seed(store: MemoryStore, who: string, canary: string) {
	const ids: string[] = [];
	for (let i = 0; i < 30; i++)
		ids.push(store.write(row(who, `${canary} fact number ${i} about gardening`)));
	for (let i = 0; i < ids.length; i += 3) store.forget(ids[i], "test");
	const db = store.db;
	for (const id of ids) {
		db.prepare(
			"INSERT INTO embeddings (memory_id, model, dimensions, vector, created_at) VALUES (?,?,?,?,?)",
		).run(id, "m", 2, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), 1);
	}
	const now = Date.now();
	const ent = (n: string) => {
		const id = `ent_${who}_${n}`;
		db.prepare(
			"INSERT INTO entities (id,type,name,first_seen,last_seen,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
		).run(id, "concept", `${canary}-${n}`, now, now, now, now);
		return id;
	};
	const e1 = ent("a");
	const e2 = ent("b");
	db.prepare(
		"INSERT INTO relationships (id,source_id,target_id,type,created_at,updated_at) VALUES (?,?,?,?,?,?)",
	).run(`rel_${who}`, e1, e2, "related_to", now, now);
	db.prepare("INSERT INTO entity_mentions (entity_id,memory_id,created_at) VALUES (?,?,?)").run(
		e1,
		ids[1],
		now,
	);
	db.prepare("INSERT INTO entity_mentions (entity_id,memory_id,created_at) VALUES (?,?,?)").run(
		e2,
		ids[2],
		now,
	);
	db.prepare(
		"INSERT INTO memory_relationships (id,source_id,target_id,type,created_at) VALUES (?,?,?,?,?)",
	).run(`mr_${who}`, ids[1], ids[2], "similar", now);
	return ids;
}

const TABLES = [
	"memories",
	"memory_versions",
	"embeddings",
	"entities",
	"relationships",
	"entity_mentions",
	"memory_relationships",
];
const counts = (s: MemoryStore) =>
	Object.fromEntries(
		TABLES.map((t) => [t, (s.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c]),
	);
const ftsHits = (s: MemoryStore, term: string) =>
	(
		s.db.prepare("SELECT COUNT(*) c FROM memories_fts WHERE memories_fts MATCH ?").get(term) as {
			c: number;
		}
	).c;
const ftsDocs = (s: MemoryStore) =>
	(s.db.prepare("SELECT COUNT(*) c FROM memories_fts_docsize").get() as { c: number }).c;

describe("MemoryStore.purge", () => {
	test("purge(A) leaves zero A rows in every table, FTS included; B untouched", () => {
		const store = new MemoryStore(":memory:");
		seed(store, "userA", "canaryalpha");
		seed(store, "userB", "canarybravo");
		const beforeB = counts(store);
		expect(beforeB.memory_versions).toBe(20); // 10 forgotten per person
		const docsBefore = ftsDocs(store);

		const res = store.purge({ userId: "userA" });

		expect(res.deleted.memories).toBe(30);
		expect(res.deleted.memory_versions).toBe(10);
		expect(res.deleted.embeddings).toBe(30);
		expect(res.deleted.entities).toBe(2);
		expect(res.deleted.relationships).toBe(1);
		expect(Object.values(res.remaining).every((n) => n === 0)).toBe(true);
		const after = counts(store);
		expect(after.memories).toBe(30);
		expect(after.memory_versions).toBe(10);
		expect(after.embeddings).toBe(30);
		expect(after.entities).toBe(2);
		expect(after.relationships).toBe(1);
		expect(ftsHits(store, "canaryalpha")).toBe(0);
		expect(ftsHits(store, "canarybravo")).toBeGreaterThan(0);
		expect(ftsDocs(store)).toBe(docsBefore - 30);
		// And the raw image no longer holds A's text, while B's is intact (the test is not vacuous).
		const raw = Buffer.from(store.db.serialize());
		expect(raw.includes("canaryalpha")).toBe(false);
		expect(raw.includes("canarybravo")).toBe(true);
	});

	test("raw file canary search after purge and VACUUM, on a real file with WAL", () => {
		const dir = mkdtempSync(join(tmpdir(), "purge-file-"));
		dirs.push(dir);
		const path = join(dir, "m.db");
		const store = new MemoryStore(path);
		seed(store, "userA", "canaryfile");
		store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect(readFileSync(path).includes("canaryfile")).toBe(true);
		store.purge({ userId: "userA" });
		store.close();
		for (const f of readdirSync(dir))
			expect(readFileSync(join(dir, f)).includes("canaryfile")).toBe(false);
	});

	test("purge({all}) empties every table and the index", () => {
		const store = new MemoryStore(":memory:");
		seed(store, "userA", "canaryone");
		seed(store, "userB", "canarytwo");
		const res = store.purge({ all: true });
		expect(Object.values(res.remaining).every((n) => n === 0)).toBe(true);
		expect(Object.values(counts(store)).every((n) => n === 0)).toBe(true);
		expect(ftsDocs(store)).toBe(0);
		const raw = Buffer.from(store.db.serialize());
		expect(raw.includes("canaryone")).toBe(false);
		expect(raw.includes("canarytwo")).toBe(false);
	});

	test("an entity shared with another person's memory survives", () => {
		const store = new MemoryStore(":memory:");
		const a = seed(store, "userA", "canaryxa");
		const b = seed(store, "userB", "canaryxb");
		const now = Date.now();
		store.db
			.prepare("INSERT INTO entity_mentions (entity_id,memory_id,created_at) VALUES (?,?,?)")
			.run("ent_userA_a", b[5], now);
		store.purge({ userId: "userA" });
		expect(
			(
				store.db.prepare("SELECT COUNT(*) c FROM entities WHERE id='ent_userA_a'").get() as {
					c: number;
				}
			).c,
		).toBe(1);
		expect(a.length).toBe(30);
	});

	test("a failed post-condition rolls back: nothing is half deleted", () => {
		const store = new MemoryStore(":memory:");
		seed(store, "userA", "canaryrb");
		// A trigger that resurrects a row makes the count check fail.
		store.db.exec(`CREATE TRIGGER resurrect AFTER DELETE ON memory_versions BEGIN
			INSERT INTO memory_versions (id,memory_id,version,data_snapshot,changed_by,created_at)
			SELECT 'zz'||old.id, old.memory_id, 1, 'x', 'x', 1; END;`);
		const before = counts(store);
		expect(() => store.purge({ userId: "userA" })).toThrow();
		expect(counts(store)).toEqual(before);
	});

	test("forget() is never on the erase path (M3)", () => {
		for (const f of [
			"telegram-memory.ts",
			"telegram-memory-vault.ts",
			"../daemon/telegram-bridge.ts",
		]) {
			const src = readFileSync(join(import.meta.dir, f), "utf8");
			expect(/\.forget\(/.test(src)).toBe(false);
		}
	});
});
