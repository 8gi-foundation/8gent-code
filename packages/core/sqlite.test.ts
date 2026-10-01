/**
 * SqliteDatabase.close() must release the database file.
 *
 * bun's Database.close() leaves the connection (and the .db, -wal and -shm
 * files) open while any db.prepare() statement is unfinalized. Linux and macOS
 * let you delete an open file, so the leak only surfaced on windows-latest as
 * EBUSY at test cleanup. isOpenByThisProcess asks the OS directly, so these
 * fail on every platform when the handle leaks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isOpenByThisProcess } from "./open-files";
import { SqliteDatabase, reclaimSweep } from "./sqlite";

let dir: string;

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function freshDb(): { file: string; db: SqliteDatabase } {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-close-"));
	const file = path.join(dir, "t.db");
	const db = new SqliteDatabase(file, { create: true });
	db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x INTEGER)");
	return { file, db };
}

describe("SqliteDatabase", () => {
	test("the probe sees an open database (so the other tests mean something)", () => {
		const { file, db } = freshDb();
		expect(isOpenByThisProcess(file)).toBe(true);
		db.close();
	});

	test("close() releases the file while a prepared statement is still referenced", () => {
		const { file, db } = freshDb();
		const insert = db.prepare("INSERT INTO t (x) VALUES (?)");
		insert.run(1);
		db.prepare("SELECT x FROM t").all();

		db.close();

		for (const f of [file, `${file}-wal`, `${file}-shm`])
			expect(isOpenByThisProcess(f)).toBe(false);
		expect(insert).toBeDefined(); // still reachable: the GC cannot be what closed it
		fs.unlinkSync(file);
		expect(fs.existsSync(file)).toBe(false);
	});

	test("statements made inside a transaction are released too", () => {
		const { file, db } = freshDb();
		db.transaction(() => {
			for (let i = 0; i < 3; i++) db.prepare("INSERT INTO t (x) VALUES (?)").run(i);
		})();
		db.close();
		expect(isOpenByThisProcess(file)).toBe(false);
	});

	test("a statement finalized by its owner, and a second close(), are both harmless", () => {
		const { file, db } = freshDb();
		const stmt = db.prepare("SELECT x FROM t");
		stmt.finalize();
		db.close();
		db.close();
		expect(isOpenByThisProcess(file)).toBe(false);
	});
});

function expectReleased(file: string): void {
	for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(isOpenByThisProcess(f)).toBe(false);
}

describe("SqliteDatabase.cached()", () => {
	test("returns one statement per SQL text and close() releases the file with no GC", async () => {
		const saved = reclaimSweep.enabled;
		reclaimSweep.enabled = false; // prove this path never needs the sweep
		try {
			const { file, db } = freshDb();
			const insert = db.cached("INSERT INTO t (x) VALUES (?)");
			expect(db.cached("INSERT INTO t (x) VALUES (?)")).toBe(insert);
			for (let i = 0; i < 50; i++) db.cached("INSERT INTO t (x) VALUES (?)").run(i);
			expect(db.cached("SELECT COUNT(*) AS c FROM t").get()).toEqual({ c: 50 });
			await Bun.sleep(1);
			Bun.gc(false);

			db.close();

			expectReleased(file);
		} finally {
			reclaimSweep.enabled = saved;
		}
	});

	test("a cached statement finalized by its owner is replaced, not reused", () => {
		const { db } = freshDb();
		const first = db.cached("SELECT x FROM t");
		first.finalize();
		const second = db.cached("SELECT x FROM t");
		expect(second).not.toBe(first);
		expect(second.all()).toEqual([]);
		db.close();
	});
});

// The sweep is on by default only on Windows. These switch it on so the
// path, and its rate limit, are tested on every platform.
describe("reclaimed but unswept statements (Windows sweep)", () => {
	const saved = { ...reclaimSweep };
	beforeEach(() => {
		reclaimSweep.enabled = true;
		reclaimSweep.minIntervalMs = 0;
		reclaimSweep.lastRunAt = Number.NEGATIVE_INFINITY;
	});
	afterEach(() => {
		reclaimSweep.enabled = saved.enabled;
		reclaimSweep.minIntervalMs = saved.minIntervalMs;
		reclaimSweep.lastRunAt = saved.lastRunAt;
	});

	test("close() releases the file when the GC has reclaimed statements but not swept them", async () => {
		const { file, db } = freshDb();
		for (let i = 0; i < 50; i++) db.prepare("INSERT INTO t (x) VALUES (?)").run(i);
		// End the job so the statements are collectable, then collect without
		// sweeping: their WeakRefs clear, but bun has not finalized them yet.
		// This is the state that kept store.test.ts locked on windows-latest.
		await Bun.sleep(1);
		Bun.gc(false);

		db.close();

		expectReleased(file);
	});

	test("statements dropped by the 512-prepare cleanup are still swept at close()", async () => {
		const { file, db } = freshDb();
		for (let i = 0; i < 511; i++) db.prepare("INSERT INTO t (x) VALUES (?)").run(i);
		await Bun.sleep(1);
		Bun.gc(false);
		// The 512th prepare runs the cleanup, which drops the 511 reclaimed
		// refs: close() can no longer see them and must rely on the flag the
		// cleanup set. One prepare, so almost no allocation sweeps them first.
		db.prepare("SELECT x FROM t").all();

		db.close();

		expectReleased(file);
	});

	test("runs at most once per minIntervalMs", async () => {
		reclaimSweep.minIntervalMs = 60_000;
		const before = reclaimSweep.runs;
		for (let round = 0; round < 2; round++) {
			const { db } = freshDb();
			for (let i = 0; i < 20; i++) db.prepare("SELECT x FROM t").all();
			await Bun.sleep(1);
			Bun.gc(false);
			db.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
		expect(reclaimSweep.runs - before).toBe(1);
	});

	test("never runs when disabled (the default off Windows)", async () => {
		reclaimSweep.enabled = false;
		const before = reclaimSweep.runs;
		const { db } = freshDb();
		for (let i = 0; i < 20; i++) db.prepare("SELECT x FROM t").all();
		await Bun.sleep(1);
		Bun.gc(false);
		db.close();
		expect(reclaimSweep.runs).toBe(before);
	});
});
