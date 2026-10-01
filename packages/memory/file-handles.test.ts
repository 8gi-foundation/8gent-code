/**
 * Closing a memory database must release its files.
 *
 * Windows will not delete or replace a file that is still open, so a store
 * that "closes" but keeps its handle breaks cleanup, rotation and uninstall
 * there (windows-latest: EBUSY in every memory suite). Linux and macOS hide
 * the leak, so these ask the OS whether the file is still open instead of
 * relying on a failed delete.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isOpenByThisProcess } from "../core/open-files";
import { SqliteDatabase, reclaimSweep } from "../core/sqlite";
import { createSharedMemoryBus } from "./bus.js";
import { recallPriorSessionsSync, writeSessionToKG } from "./session-kg.js";
import { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

let dir: string;
const savedDataDir = process.env.EIGHT_DATA_DIR;

afterEach(() => {
	if (savedDataDir === undefined) delete process.env.EIGHT_DATA_DIR;
	else process.env.EIGHT_DATA_DIR = savedDataDir;
	fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-handles-"));
	return dir;
}

function expectReleased(file: string): void {
	for (const f of [file, `${file}-wal`, `${file}-shm`]) expect(isOpenByThisProcess(f)).toBe(false);
}

describe("memory databases release their files on close", () => {
	test("MemoryStore.close() after reads and writes", async () => {
		const file = path.join(tempDir(), "memory.db");
		const store = new MemoryStore(file);
		const now = Date.now();
		const id = store.write({
			id: "mem-handles-1",
			type: "core",
			scope: "project",
			category: "architecture",
			key: "k",
			title: "Handles",
			content: "close() must release the file after a write",
			confidence: 0.9,
			evidenceCount: 1,
			tags: ["test"],
			importance: 0.7,
			decayFactor: 1.0,
			accessCount: 0,
			lastAccessed: now,
			createdAt: now,
			updatedAt: now,
			version: 1,
			source: "user_explicit",
		} as Memory);
		store.update(id, { content: "updated" } as Partial<Memory>, "test", "test-user");
		store.get(id);
		store.getStats();
		store.get("no-such-id");
		expect(isOpenByThisProcess(file)).toBe(true);
		// Let the GC reclaim any per-call statement without sweeping it, as it
		// does when other suites share the process (windows-latest).
		await Bun.sleep(1);
		Bun.gc(false);

		store.close();

		expectReleased(file);
	});

	test("MemoryStore never needs the Windows GC sweep to release its file", async () => {
		// MemoryStore runs every query through db.cached(), so close() must
		// release the file with the sweep switched off. A per-call prepare()
		// (the sqlite-vec version probe was one) shows up only under a large
		// heap and over a few rounds, as in a full test run: a small heap
		// sweeps eagerly and hides it.
		const savedSweep = reclaimSweep.enabled;
		reclaimSweep.enabled = false;
		const ballast = Array.from({ length: 300_000 }, (_, i) => ({ i, s: `b${i}` }));
		const leaked: number[] = [];
		try {
			const root = tempDir();
			for (let round = 0; round < 10; round++) {
				const file = path.join(root, `memory-${round}.db`);
				const store = new MemoryStore(file);
				store.getStats();
				store.get("no-such-id");
				await Bun.sleep(1);
				Bun.gc(false);
				store.close();
				if ([file, `${file}-wal`, `${file}-shm`].some(isOpenByThisProcess)) leaked.push(round);
			}
		} finally {
			reclaimSweep.enabled = savedSweep;
		}
		expect(leaked).toEqual([]);
		expect(ballast.length).toBe(300_000);
	});

	test("SharedMemoryBus.close() releases the store and its own statements", () => {
		const file = path.join(tempDir(), "shared.db");
		const bus = createSharedMemoryBus(file);
		bus.storeMessage("hello", "user", { source: "discord", scope: "discord:c1:8EO" });
		bus.getConversation("discord:c1:8EO");

		bus.close();

		expectReleased(file);
	});

	test("session recall closes the database even when the query throws", () => {
		process.env.EIGHT_DATA_DIR = tempDir();
		const file = path.join(dir, "memory", "memory.db");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// A memory database without the knowledge graph tables: the recall
		// query fails, which used to skip db.close().
		const seed = new SqliteDatabase(file, { create: true });
		seed.exec("CREATE TABLE memories (scope TEXT, content_text TEXT)");
		seed.close();

		expect(recallPriorSessionsSync(dir)).toBe("");

		expectReleased(file);
	});

	test("the session write closes the database it opened", async () => {
		process.env.EIGHT_DATA_DIR = tempDir();
		const file = path.join(dir, "memory", "memory.db");

		await writeSessionToKG({
			sessionId: "s1",
			summary: "Fixed the parser with Ada Lovelace",
			cwd: dir,
			filesCreated: ["a.ts"],
			filesModified: [],
			durationMs: 1,
		});

		expect(fs.existsSync(file)).toBe(true);
		expectReleased(file);
	});
});
