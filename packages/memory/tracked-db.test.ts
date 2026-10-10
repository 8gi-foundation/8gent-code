import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { trackStatements, trackedCount } from "./tracked-db.js";

describe("trackStatements (#3814)", () => {
	it("finalizes live statements on close", () => {
		const db = trackStatements(new Database(":memory:"));
		db.exec("CREATE TABLE t (a INTEGER)");
		const held = db.prepare("SELECT * FROM t");
		const cached = db.query("SELECT a FROM t");
		held.all();
		cached.all();
		db.close();
		// A finalized statement refuses to run.
		expect(() => held.all()).toThrow();
		expect(() => cached.all()).toThrow();
		expect(trackedCount(db)).toBe(0);
	});

	it("does not pin statements nobody holds: the record stays bounded", async () => {
		const db = trackStatements(new Database(":memory:"));
		db.exec("CREATE TABLE t (a INTEGER)");
		for (let round = 0; round < 5; round++) {
			for (let i = 0; i < 500; i++) db.prepare("SELECT * FROM t WHERE a = ?").get(i);
			// Test only, never product code: WeakRef targets stay alive until the end of the
			// current turn, so yield first, then collect the unreferenced statements now.
			await Bun.sleep(0);
			Bun.gc(true);
		}
		for (let i = 0; i < 100; i++) db.prepare("SELECT 1").get();
		// 2600 prepares in total; only the prune headroom survives, not one entry per call.
		expect(trackedCount(db)).toBeLessThan(600);
		db.close();
	});

	it("still behaves as a Database", () => {
		const db = trackStatements(new Database(":memory:"));
		db.exec("CREATE TABLE t (a INTEGER)");
		db.prepare("INSERT INTO t (a) VALUES (?)").run(7);
		expect(db.query("SELECT a FROM t").get()).toEqual({ a: 7 });
		db.close();
	});
});
