import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
	type IndexableSession,
	forgetIndexedSessions,
	indexSessions,
	searchSessionTurns,
} from "./session-index.js";

const sess = (
	id: string,
	texts: string[],
	lastActiveAt = "2026-11-01T10:00:00.000Z",
): IndexableSession => ({
	id,
	lastActiveAt,
	messages: texts.map((content, i) => ({ role: i % 2 ? "assistant" : "user", content })),
});

describe("session-index", () => {
	let db: Database;
	beforeEach(() => {
		db = new Database(":memory:");
	});
	afterEach(() => db.close());

	it("indexes on first use, then finds turns with date, id and snippet", () => {
		const n = indexSessions(db, [
			sess("aaaa1111", ["how do I rotate the signing keys", "use the vault"]),
		]);
		expect(n).toBe(2);
		const hits = searchSessionTurns(db, "signing keys");
		expect(hits).toHaveLength(1);
		expect(hits[0].sessionId).toBe("aaaa1111");
		expect(hits[0].date).toBe("2026-11-01");
		expect(hits[0].snippet).toContain("signing");
	});

	it("is incremental: unchanged sessions are skipped, grown ones are re-read", () => {
		const s = sess("bbbb2222", ["alpha topic"]);
		expect(indexSessions(db, [s])).toBe(1);
		expect(indexSessions(db, [s])).toBe(0);
		expect(indexSessions(db, [sess("bbbb2222", ["alpha topic", "beta reply"])])).toBe(2);
		expect(searchSessionTurns(db, "alpha")).toHaveLength(1);
		expect(searchSessionTurns(db, "beta")).toHaveLength(1);
	});

	it("returns at most 10 hits, one per session, and survives FTS syntax in input", () => {
		const many = Array.from({ length: 15 }, (_, i) =>
			sess(`cccc${String(i).padStart(4, "0")}`, ["needle in a haystack"]),
		);
		indexSessions(db, many);
		expect(searchSessionTurns(db, "needle")).toHaveLength(10);
		expect(searchSessionTurns(db, 'needle" OR (')).toBeArray();
		expect(searchSessionTurns(db, "   ")).toEqual([]);
	});

	const rowsFor = (id: string) =>
		(
			db.prepare("SELECT COUNT(*) AS c FROM session_turns_fts WHERE session_id = ?").get(id) as {
				c: number;
			}
		).c +
		(
			db.prepare("SELECT COUNT(*) AS c FROM session_turns_state WHERE session_id = ?").get(id) as {
				c: number;
			}
		).c;

	it("drops a session that is no longer in the live set (trashed or deleted)", () => {
		indexSessions(db, [sess("keep0001", ["kept turn marker"]), sess("gone0001", ["trashed turn marker"])]);
		expect(searchSessionTurns(db, "marker")).toHaveLength(2);
		// gone0001 was trashed: the next sync lists only keep0001.
		indexSessions(db, [sess("keep0001", ["kept turn marker"])]);
		expect(searchSessionTurns(db, "marker").map((h) => h.sessionId)).toEqual(["keep0001"]);
		expect(rowsFor("gone0001")).toBe(0);
		expect(rowsFor("keep0001")).toBeGreaterThan(0);
		// An empty live set empties the index.
		indexSessions(db, []);
		expect(rowsFor("keep0001")).toBe(0);
	});

	it("forgetIndexedSessions removes only the named sessions' turns and state", () => {
		indexSessions(db, [sess("aaaa0001", ["one", "two"]), sess("bbbb0001", ["three"])]);
		expect(forgetIndexedSessions(db, ["aaaa0001"])).toBe(2);
		expect(rowsFor("aaaa0001")).toBe(0);
		expect(rowsFor("bbbb0001")).toBe(2);
		expect(forgetIndexedSessions(db, ["nope0001"])).toBe(0);
	});
});
