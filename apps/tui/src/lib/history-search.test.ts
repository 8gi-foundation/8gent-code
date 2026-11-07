import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	type SessionSource,
	formatHits,
	parseHistoryArgs,
	runHistorySearch,
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
