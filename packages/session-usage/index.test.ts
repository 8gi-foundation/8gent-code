import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatRows,
	listSessions,
	MAX_PRINT_CHARS,
	MAX_RECORD_BYTES,
	MAX_SESSION_CHARS,
	printable,
	readRecord,
	safeName,
	type SessionUsageRecord,
	writeRecord,
} from "./index";
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

	test("a new folder is 0o700 and a record file is 0o600", () => {
		const sub = path.join(dir, "fresh");
		const f = writeRecord(base(), sub);
		expect(fs.statSync(sub).mode & 0o777).toBe(0o700);
		expect(fs.statSync(f).mode & 0o777).toBe(0o600);
	});

	test("an existing folder keeps its mode: not widened, not refused", () => {
		const sub = path.join(dir, "old");
		fs.mkdirSync(sub, { mode: 0o755 });
		fs.chmodSync(sub, 0o755);
		const f = writeRecord(base(), sub);
		expect(fs.statSync(sub).mode & 0o777).toBe(0o755);
		expect(fs.statSync(f).mode & 0o777).toBe(0o600);
	});

	test("a file planted at the temp name is not written through", () => {
		const tmp = path.join(dir, `s1.json.${process.pid}.tmp`);
		const target = path.join(dir, "victim");
		fs.writeFileSync(target, "keep");
		fs.symlinkSync(target, tmp);
		expect(() => writeRecord(base(), dir)).toThrow();
		expect(fs.readFileSync(target, "utf8")).toBe("keep");
		expect(fs.lstatSync(tmp).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(path.join(dir, "s1.json"))).toBe(false);
		fs.unlinkSync(tmp);
		fs.writeFileSync(tmp, "planted");
		expect(() => writeRecord(base(), dir)).toThrow();
		expect(fs.readFileSync(tmp, "utf8")).toBe("planted");
	});

	test("a failed rename removes the temp file", () => {
		const blocker = path.join(dir, "s1.json");
		fs.mkdirSync(blocker);
		fs.writeFileSync(path.join(blocker, "child"), "x");
		expect(() => writeRecord(base(), dir)).toThrow();
		expect(fs.readdirSync(dir)).toEqual(["s1.json"]);
	});

	test("control characters never reach the printed table", () => {
		writeRecord(base({ session: "evil\x1b]0;pwned\x07\x9b2J", account: "a\x1b[31m", harness: "h\x7f" }), dir);
		const out = formatRows(listSessions({ dir, now: 1_000_000 }));
		expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
		expect(out).toContain("evil?]0;pwned??2J");
	});

	test("printed strings are length capped", () => {
		expect(printable("x".repeat(500)).length).toBe(MAX_PRINT_CHARS);
		writeRecord(base({ session: "y".repeat(180) }), dir);
		const first = formatRows(listSessions({ dir, now: 1_000_000 })).split("\n")[1];
		expect(first.split(/\s{2,}/)[0].length).toBe(MAX_PRINT_CHARS);
	});

	test("an oversized record file is skipped", () => {
		const pad = " ".repeat(MAX_RECORD_BYTES);
		fs.writeFileSync(path.join(dir, "big.json"), JSON.stringify(base({ session: "big" })) + pad);
		writeRecord(base({ session: "ok" }), dir);
		expect(listSessions({ dir, now: 1_000_000 }).map((r) => r.session)).toEqual(["ok"]);
	});

	test("a non-regular entry named like a record is skipped", () => {
		fs.mkdirSync(path.join(dir, "x.json"));
		const target = path.join(dir, "real");
		fs.writeFileSync(target, JSON.stringify(base({ session: "linked" })));
		fs.symlinkSync(target, path.join(dir, "link.json"));
		writeRecord(base({ session: "ok" }), dir);
		expect(listSessions({ dir, now: 1_000_000 }).map((r) => r.session)).toEqual(["ok"]);
	});

	test("a stored session name is capped when parsed", () => {
		fs.writeFileSync(path.join(dir, "long.json"), JSON.stringify(base({ session: "z".repeat(5000) })));
		const r = readRecord(path.join(dir, "long.json"));
		expect(r?.session.length).toBe(MAX_SESSION_CHARS);
	});

	test("sessions whose cleaned names match keep separate files", () => {
		writeRecord(base({ session: "a/b" }), dir);
		writeRecord(base({ session: "a_b" }), dir);
		writeRecord(base({ session: "q".repeat(130) + "1" }), dir);
		writeRecord(base({ session: "q".repeat(130) + "2" }), dir);
		const names = listSessions({ dir, now: 1_000_000 }).map((r) => r.session);
		expect(names.length).toBe(4);
		expect(names).toContain("a/b");
		expect(names).toContain("a_b");
		expect(safeName("a_b")).toBe("a_b");
		expect(safeName("a/b")).toMatch(/^a_b-[0-9a-f]{8}$/);
		expect(safeName("")).toMatch(/^unnamed-[0-9a-f]{8}$/);
	});

	test("path separators and dots never escape the folder", () => {
		const f = writeRecord(base({ session: "../../etc/x" }), dir);
		expect(path.dirname(f)).toBe(dir);
	});

	test("reported percentage wins over total_input_tokens", () => {
		const rec = recordFromStatusJson(
			{ session_id: "p", context_window: { context_window_size: 200000, used_percentage: 25, total_input_tokens: 680000 } },
			{ now: new Date(0) },
		);
		expect(rec?.contextUsed).toBe(50000);
		writeRecord(rec!, dir);
		const row = listSessions({ dir, now: 0 })[0];
		expect(Math.round(row.contextPct!)).toBe(25);
	});

	test("total_input_tokens is used only when no percentage is reported; zero window gives no guess", () => {
		const a = recordFromStatusJson(
			{ session_id: "t", context_window: { context_window_size: 1000, total_input_tokens: 300 } },
			{},
		);
		expect(a?.contextUsed).toBe(300);
		const b = recordFromStatusJson(
			{ session_id: "z", context_window: { context_window_size: 0, used_percentage: 50 } },
			{},
		);
		expect(b?.contextUsed).toBeNull();
	});
});
