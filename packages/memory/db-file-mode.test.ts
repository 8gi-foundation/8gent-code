/**
 * memory.db holds copies of session turns (/history search), and session files
 * are 0600. The db, its -wal and -shm, and their folder must be owner-only too,
 * whether the store creates them or finds them already looser on disk.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexSessions } from "./session-index.js";
import { MemoryStore } from "./store.js";

const posix = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
	const d = mkdtempSync(join(tmpdir(), "db-mode-"));
	dirs.push(d);
	return d;
}

/** Write one turn so the WAL and shared-memory files exist and hold data. */
function touch(store: MemoryStore) {
	indexSessions(store.db, [
		{
			id: "mode0001",
			lastActiveAt: "2026-11-01T10:00:00.000Z",
			messages: [{ role: "user", content: "private turn" }],
		},
	]);
}

describe.if(posix)("MemoryStore file modes", () => {
	test("a fresh store creates the folder 0700 and db, -wal, -shm 0600", () => {
		const dir = join(scratch(), "memory");
		const db = join(dir, "memory.db");
		const store = new MemoryStore(db);
		touch(store);
		expect(mode(dir)).toBe(0o700);
		for (const f of [db, `${db}-wal`, `${db}-shm`]) {
			expect(existsSync(f)).toBe(true);
			expect(mode(f)).toBe(0o600);
		}
		store.close();
	});

	test("existing 0644 files in a 0755 folder are tightened on open", () => {
		const dir = join(scratch(), "memory");
		mkdirSync(dir, { mode: 0o755 });
		chmodSync(dir, 0o755);
		const db = join(dir, "memory.db");
		// An older build: plain open, WAL on, files left at the umask default.
		const old = new Database(db, { create: true });
		old.exec("PRAGMA journal_mode = WAL");
		old.exec("CREATE TABLE t (x)");
		old.exec("INSERT INTO t VALUES (1)");
		for (const f of [db, `${db}-wal`, `${db}-shm`]) chmodSync(f, 0o644);
		expect(mode(db)).toBe(0o644);
		expect(mode(`${db}-wal`)).toBe(0o644);

		const store = new MemoryStore(db);
		touch(store);
		expect(mode(dir)).toBe(0o700);
		for (const f of [db, `${db}-wal`, `${db}-shm`]) expect(mode(f)).toBe(0o600);
		store.close();
		old.close();
	});

	test("in-memory stores touch nothing on disk", () => {
		const store = new MemoryStore(":memory:");
		touch(store);
		expect(existsSync(":memory:")).toBe(false);
		store.close();
	});
});
