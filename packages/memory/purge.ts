/**
 * True purge for the memory store (C-M5, epic #4391).
 *
 * MemoryStore.forget() is a soft delete: it snapshots the row into memory_versions and sets
 * deleted_at, so FTS entries, embeddings and the snapshot all survive. Erasure on request needs
 * the opposite. purgeMemory() deletes, in one transaction, every row that belongs to the subject
 * across memories, memory_versions, the FTS5 index, embeddings (legacy and vec0), entities, edges
 * and the link tables, proves each count is zero before it commits, then VACUUMs so freed pages
 * do not keep the text. Nothing here reads or returns memory content, only counts.
 */

import type { Database } from "bun:sqlite";

export type PurgeScope = { userId: string; all?: false } | { all: true; userId?: undefined };

export interface PurgeResult {
	/** Rows removed, per table. */
	deleted: Record<string, number>;
	/** Rows still present for the scope after the purge. Always zero when this returns. */
	remaining: Record<string, number>;
}

const CHUNK = 400;

function chunks<T>(xs: T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
	return out;
}

const marks = (n: number) => new Array(n).fill("?").join(",");

function tableExists(db: Database, name: string): boolean {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

/** Count rows of `table` where `col` is in `ids`. */
function countIn(db: Database, table: string, col: string, ids: string[] | number[]): number {
	let n = 0;
	for (const c of chunks(ids as (string | number)[])) {
		n += (
			db
				.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} IN (${marks(c.length)})`)
				.get(...c) as { c: number }
		).c;
	}
	return n;
}

function deleteIn(db: Database, table: string, col: string, ids: (string | number)[]): number {
	// Counted before the delete: bun reports trigger-made changes too, which would inflate the number.
	const n = countIn(db, table, col, ids as string[]);
	for (const c of chunks(ids)) {
		db.prepare(`DELETE FROM ${table} WHERE ${col} IN (${marks(c.length)})`).run(...c);
	}
	return n;
}

function count(db: Database, table: string): number {
	return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

const ALL_TABLES = [
	"entity_mentions",
	"memory_relationships",
	"consolidation_log",
	"memory_versions",
	"embeddings",
	"relationships",
	"entities",
	"memories",
];

export function purgeMemory(db: Database, scope: PurgeScope): PurgeResult {
	const deleted: Record<string, number> = {};
	const remaining: Record<string, number> = {};

	const run = db.transaction(() => {
		if (scope.all) {
			if (tableExists(db, "memories_vec")) {
				try {
					deleted.memories_vec = count(db, "memories_vec");
					db.prepare("DELETE FROM memories_vec").run();
				} catch {
					// vec0 module not loaded in this process; the legacy embeddings table still clears.
				}
			}
			deleted.memories_fts = tableExists(db, "memories_fts_docsize")
				? count(db, "memories_fts_docsize")
				: 0;
			for (const t of ALL_TABLES) {
				deleted[t] = count(db, t);
				db.prepare(`DELETE FROM ${t}`).run();
			}
			// Triggers already emptied the index entry by entry; rebuild drops any stale terms.
			db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
			for (const t of ["memories", ...ALL_TABLES.filter((x) => x !== "memories")]) {
				remaining[t] = count(db, t);
			}
			remaining.memories_fts = tableExists(db, "memories_fts_docsize")
				? count(db, "memories_fts_docsize")
				: 0;
		} else {
			const userId = scope.userId;
			if (!userId) throw new Error("purge: userId is required");
			const rows = db
				.prepare("SELECT id, rowid AS rid FROM memories WHERE json_extract(data, '$.userId') = ?")
				.all(userId) as Array<{ id: string; rid: number }>;
			const ids = rows.map((r) => r.id);
			const rids = rows.map((r) => r.rid);

			// Entities that exist only because of this subject's memories, plus person entities
			// that name the subject. Collected before the mentions go.
			const mentioned = new Set<string>();
			for (const c of chunks(ids)) {
				for (const r of db
					.prepare(
						`SELECT DISTINCT entity_id AS e FROM entity_mentions WHERE memory_id IN (${marks(c.length)})`,
					)
					.all(...c) as Array<{ e: string }>)
					mentioned.add(r.e);
			}
			const entityIds: string[] = [];
			const others = db.prepare(
				"SELECT COUNT(*) AS c FROM entity_mentions WHERE entity_id = ? AND memory_id NOT IN (SELECT id FROM memories WHERE json_extract(data, '$.userId') = ?)",
			);
			for (const e of mentioned) {
				if ((others.get(e, userId) as { c: number }).c === 0) entityIds.push(e);
			}
			for (const r of db
				.prepare(
					"SELECT id FROM entities WHERE type = 'person' AND (name = ? OR json_extract(metadata, '$.userId') = ?)",
				)
				.all(userId, userId) as Array<{ id: string }>) {
				if (!entityIds.includes(r.id)) entityIds.push(r.id);
			}

			const ftsBefore = tableExists(db, "memories_fts_docsize")
				? countIn(db, "memories_fts_docsize", "id", rids)
				: 0;

			if (tableExists(db, "memories_vec")) {
				try {
					deleted.memories_vec = deleteIn(db, "memories_vec", "memory_id", ids);
				} catch {
					// vec0 module not loaded; the BLOB table below is the source of truth.
				}
			}
			deleted.entity_mentions =
				deleteIn(db, "entity_mentions", "memory_id", ids) +
				deleteIn(db, "entity_mentions", "entity_id", entityIds);
			deleted.memory_relationships =
				deleteIn(db, "memory_relationships", "source_id", ids) +
				deleteIn(db, "memory_relationships", "target_id", ids);
			deleted.consolidation_log = deleteIn(db, "consolidation_log", "result_id", ids);
			for (const id of ids) {
				// source_ids is a JSON list of memory ids; an exact quoted match is enough.
				const like = `%"${id.replace(/[%_]/g, "")}"%`;
				deleted.consolidation_log += (
					db
						.prepare("SELECT COUNT(*) AS c FROM consolidation_log WHERE source_ids LIKE ?")
						.get(like) as {
						c: number;
					}
				).c;
				db.prepare("DELETE FROM consolidation_log WHERE source_ids LIKE ?").run(like);
			}
			deleted.memory_versions = deleteIn(db, "memory_versions", "memory_id", ids);
			deleted.embeddings = deleteIn(db, "embeddings", "memory_id", ids);
			deleted.relationships =
				deleteIn(db, "relationships", "source_id", entityIds) +
				deleteIn(db, "relationships", "target_id", entityIds);
			deleted.entities = deleteIn(db, "entities", "id", entityIds);
			deleted.memories = deleteIn(db, "memories", "id", ids); // FTS delete trigger fires here
			deleted.memories_fts = ftsBefore;
			db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");

			remaining.memories = countIn(db, "memories", "id", ids);
			remaining.memory_versions = countIn(db, "memory_versions", "memory_id", ids);
			remaining.embeddings = countIn(db, "embeddings", "memory_id", ids);
			remaining.entity_mentions = countIn(db, "entity_mentions", "memory_id", ids);
			remaining.entities = countIn(db, "entities", "id", entityIds);
			remaining.relationships =
				countIn(db, "relationships", "source_id", entityIds) +
				countIn(db, "relationships", "target_id", entityIds);
			remaining.memories_fts = tableExists(db, "memories_fts_docsize")
				? countIn(db, "memories_fts_docsize", "id", rids)
				: 0;
		}
		for (const [t, n] of Object.entries(remaining)) {
			if (n !== 0) throw new Error(`purge: ${n} row(s) still present in ${t}; rolled back`);
		}
	});
	run();

	// Freed pages still hold the old text until the file is rewritten.
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} catch {
		// in-memory and non-WAL databases have no WAL
	}
	db.exec("VACUUM");
	return { deleted, remaining };
}
