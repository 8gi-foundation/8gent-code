import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatRows, listSessions, readRecord, type SessionUsageRecord, writeRecord } from "./index";
import { recordFromStatusJson } from "./statusline";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-usage-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const base = (o: Partial<SessionUsageRecord> = {}): SessionUsageRecord => ({
	version: 1,
	session: "s1",
	workspace: "w",
	harness: "h",
	account: "a",
	contextUsed: 50,
	contextWindow: 100,
	usagePct: 40,
	updatedAt: new Date(1_000_000).toISOString(),
	...o,
});

describe("session usage", () => {
	test("a record round-trips and leaves no temp file", () => {
		const r = base();
		const f = writeRecord(r, dir);
		expect(readRecord(f)).toEqual(r);
		expect(fs.readdirSync(dir)).toEqual(["s1.json"]);
	});

	test("a stale record is marked stale, a fresh one is not", () => {
		writeRecord(base({ session: "old" }), dir);
		writeRecord(base({ session: "new", updatedAt: new Date(1_000_000 + 9 * 60_000).toISOString() }), dir);
		const rows = listSessions({ dir, now: 1_000_000 + 10 * 60_000, staleMs: 5 * 60_000 });
		expect(Object.fromEntries(rows.map((r) => [r.session, r.stale]))).toEqual({ old: true, new: false });
	});

	test("missing numbers show as unknown, never zero", () => {
		writeRecord(base({ contextUsed: null, usagePct: null, account: null }), dir);
		const out = formatRows(listSessions({ dir, now: 1_000_000 }));
		expect(out.split("\n")[1].split(/\s{2,}/)).toEqual(["s1", "unknown", "h", "unknown", "unknown", "live"]);
	});

	test("sorted by nearest limit, unknown last", () => {
		writeRecord(base({ session: "a", usagePct: 10 }), dir);
		writeRecord(base({ session: "b", usagePct: 90 }), dir);
		writeRecord(base({ session: "c", usagePct: null }), dir);
		expect(listSessions({ dir, now: 1_000_000 }).map((r) => r.session)).toEqual(["b", "a", "c"]);
	});

	test("corrupt files are skipped; empty folder lists nothing", () => {
		fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
		expect(listSessions({ dir })).toEqual([]);
		expect(listSessions({ dir: path.join(dir, "missing") })).toEqual([]);
	});

	test("status JSON maps to a record; unreported fields are null", () => {
		const rec = recordFromStatusJson(
			{ session_id: "abc", cwd: "/x/proj", context_window: { context_window_size: 200000, used_percentage: 25 } },
			{ harness: "h", now: new Date(0) },
		);
		expect(rec).toMatchObject({ session: "abc", workspace: "proj", contextUsed: 50000, contextWindow: 200000, usagePct: null, account: null });
	});

	test("nothing is fetched: listing and parsing never call fetch", () => {
		const real = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("network used");
		}) as any;
		try {
			writeRecord(base(), dir);
			listSessions({ dir });
			recordFromStatusJson({ session_id: "z" }, {});
		} finally {
			globalThis.fetch = real;
		}
	});
});
