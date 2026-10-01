/**
 * SqliteDatabase.close() must release the database file.
 *
 * bun's Database.close() leaves the connection (and the .db, -wal and -shm
 * files) open while any db.prepare() statement is unfinalized. Linux and macOS
 * let you delete an open file, so the leak only surfaced on windows-latest as
 * EBUSY at test cleanup. isOpenByThisProcess asks the OS directly, so these
 * fail on every platform when the handle leaks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isOpenByThisProcess } from "./open-files";
import { SqliteDatabase } from "./sqlite";

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
