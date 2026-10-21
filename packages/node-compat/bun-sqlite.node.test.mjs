// Runs the sqlite adapter on real Node (22.5+), not under Bun:
//   node --experimental-strip-types --experimental-sqlite --test packages/node-compat/bun-sqlite.node.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { Database, hasSeveralStatements } from "./bun-sqlite.ts";

test("query/run/get/all/values/transaction behave like bun:sqlite", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, ok INTEGER)");
	const ins = db.query("INSERT INTO t (name, ok) VALUES (?, ?)");
	assert.equal(ins.run("a", true).changes, 1);
	db.transaction(() => {
		ins.run("b", false);
		ins.run("c", undefined);
	})();
	assert.deepEqual(
		{ ...db.query("SELECT * FROM t WHERE name = ?").get("a") },
		{ id: 1, name: "a", ok: 1 },
	);
	assert.equal(db.query("SELECT * FROM t WHERE name = ?").get("zzz"), null);
	assert.equal(db.query("SELECT name FROM t ORDER BY id").all().length, 3);
	assert.deepEqual(db.query("SELECT name FROM t WHERE id = $id").values({ $id: 2 }), [["b"]]);
	db.close();
});

test("nested transaction uses savepoints", () => {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE t (n INTEGER)");
	const ins = db.query("INSERT INTO t VALUES (?)");
	const inner = db.transaction((n) => {
		ins.run(n);
		throw new Error("inner");
	});
	db.transaction(() => {
		ins.run(1);
		try {
			inner(2);
		} catch {}
		ins.run(3);
	})();
	assert.deepEqual(
		db
			.query("SELECT n FROM t ORDER BY n")
			.all()
			.map((r) => r.n),
		[1, 3],
	);
	db.close();
});

test("db.run runs every statement, and refuses params with several", () => {
	const db = new Database(":memory:");
	db.run("CREATE TABLE a (x); CREATE TABLE b (y); INSERT INTO a VALUES (1);");
	assert.equal(db.query("SELECT count(*) AS n FROM a").get().n, 1);
	assert.throws(
		() => db.run("INSERT INTO a VALUES (?); INSERT INTO a VALUES (?)", 1, 2),
		/several statements/,
	);
	assert.equal(hasSeveralStatements("SELECT 1;"), false);
	assert.equal(hasSeveralStatements("SELECT 1; SELECT 2"), true);
	db.close();
});
