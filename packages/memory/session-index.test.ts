import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { type IndexableSession, indexSessions, searchSessionTurns } from "./session-index.js";

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
});
