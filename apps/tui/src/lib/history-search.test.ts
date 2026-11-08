import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchSessionTurns } from "../../../../packages/memory/session-index.js";
import {
	type SessionSource,
	forgetTrashedSession,
	formatHits,
	parseHistoryArgs,
	runHistorySearch,
	withHistoryIndex,
} from "./history-search.js";

describe("parseHistoryArgs", () => {
	test("no arguments keeps the browser", () => {
		expect(parseHistoryArgs([])).toEqual({ kind: "browse" });
	});
	test("search and open", () => {
		expect(parseHistoryArgs(["search", "vault", "keys"])).toEqual({ kind: "search", query: "vault keys" });
		expect(parseHistoryArgs(["open", "ab12cd34"])).toEqual({ kind: "open", id: "ab12cd34" });
	});
	test("a bare subcommand or unknown word shows usage", () => {
		expect(parseHistoryArgs(["search"]).kind).toBe("usage");
		expect(parseHistoryArgs(["open"]).kind).toBe("usage");
		expect(parseHistoryArgs(["nope"]).kind).toBe("usage");
	});
});

describe("runHistorySearch", () => {
	const data: Record<string, string[]> = {
		s1: ["deploy the daemon to hetzner", "done"],
		s2: ["unrelated chat"],
	};
	const source: SessionSource = {
		list: () => Object.keys(data).map((id) => ({ id, lastActiveAt: "2026-10-30T08:00:00.000Z" })),
		get: (id) => ({ messages: data[id].map((content) => ({ role: "user", content })) }),
	};

	test("indexes on first use, finds the turn, formats date id snippet", () => {
		const db = new Database(":memory:");
		const hits = runHistorySearch(db, source, "hetzner");
		expect(hits.map((h) => h.sessionId)).toEqual(["s1"]);
		const out = formatHits("hetzner", hits);
		expect(out).toContain("2026-10-30");
		expect(out).toContain("s1");
		expect(out).toContain("/history open <id>");
		data.s2.push("hetzner is mentioned later");
		expect(runHistorySearch(db, source, "hetzner").map((h) => h.sessionId).sort()).toEqual(["s1", "s2"]);
		db.close();
	});

	test("no hits says so", () => {
		expect(formatHits("zzz", [])).toBe('No past sessions match "zzz".');
	});
});

describe("forgetTrashedSession", () => {
	test("removes the trashed session's turns from the on-disk index at once", () => {
		const dir = mkdtempSync(join(tmpdir(), "hist-trash-"));
		try {
			const dbPath = join(dir, "memory", "memory.db");
			const data: Record<string, string[]> = { t1: ["secret plan alpha"], t2: ["secret plan beta"] };
			const source: SessionSource = {
				list: () => Object.keys(data).map((id) => ({ id, lastActiveAt: "2026-10-30T08:00:00.000Z" })),
				get: (id) => ({ messages: data[id].map((content) => ({ role: "user", content })) }),
			};
			expect(withHistoryIndex((db) => runHistorySearch(db, source, "secret"), dbPath)).toHaveLength(2);
			expect(forgetTrashedSession("t1", dbPath)).toBe(1);
			const left = withHistoryIndex((db) => searchSessionTurns(db, "secret"), dbPath);
			expect(left.map((h) => h.sessionId)).toEqual(["t2"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("never creates memory.db when there is no index yet", () => {
		const dir = mkdtempSync(join(tmpdir(), "hist-trash-none-"));
		try {
			const dbPath = join(dir, "memory", "memory.db");
			expect(forgetTrashedSession("t1", dbPath)).toBe(0);
			expect(existsSync(dbPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
