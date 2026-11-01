import { describe, expect, test } from "bun:test";
import { randomUUIDv7, spawnSync } from "./bun-shim";
import { Database } from "./bun-sqlite";

let hasNodeSqlite = true;
try {
	new Database(":memory:").close();
} catch {
	hasNodeSqlite = false;
}

describe("bun-shim", () => {
	test("randomUUIDv7 is a v7 uuid", () => {
		expect(randomUUIDv7()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
	test("spawnSync captures stdout and exit code", () => {
		const r = spawnSync(["node", "-e", "console.log('hi');process.exit(3)"]);
		expect(r.exitCode).toBe(3);
		expect(r.stdout.toString().trim()).toBe("hi");
	});
});

describe.skipIf(!hasNodeSqlite)("bun-sqlite adapter", () => {
	test("query/run/get/all/values/transaction match bun:sqlite semantics", () => {
		const db = new Database(":memory:");
		db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, ok INTEGER)");
		const ins = db.query("INSERT INTO t (name, ok) VALUES (?, ?)");
		expect(ins.run("a", true).changes).toBe(1);
		db.transaction(() => {
			ins.run("b", false);
			ins.run("c", undefined);
		})();
		expect(db.query("SELECT * FROM t WHERE name = ?").get("a")).toEqual({
			id: 1,
			name: "a",
			ok: 1,
		});
		expect(db.query("SELECT * FROM t WHERE name = ?").get("zzz")).toBeNull();
		expect(db.query("SELECT name FROM t ORDER BY id").all()).toHaveLength(3);
		expect(db.query("SELECT name FROM t WHERE id = $id").values({ $id: 2 })).toEqual([["b"]]);
		expect(() =>
			db.transaction(() => {
				ins.run("d", 1);
				throw new Error("boom");
			})(),
		).toThrow("boom");
		expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
		db.close();
	});
});
