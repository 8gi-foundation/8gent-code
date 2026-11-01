/**
 * Run from HOME (or EIGHT_DATA_DIR's parent), the project and global memory
 * DBs are one file. MemoryManager must treat them as one store, or every
 * cross-store read sees each memory twice (#4135).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./index";

const KEYS = ["HOME", "EIGHT_HOME", "EIGHT_DATA_DIR"] as const;
const saved: Record<string, string | undefined> = {};
const home = mkdtempSync(join(tmpdir(), "8gent-shared-store-"));
let manager: MemoryManager;

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	process.env.HOME = home;
	process.env.EIGHT_HOME = join(home, ".8gent");
	process.env.EIGHT_DATA_DIR = join(home, ".8gent");
	manager = new MemoryManager(home);
});

afterAll(() => {
	manager?.close();
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(home, { recursive: true, force: true });
});

describe("MemoryManager with project and global on one file", () => {
	test("getContext returns a memory once", async () => {
		await manager.remember("the release pipeline runs on tagged commits only", "semantic", {
			scope: "project",
		});
		const ctx = await manager.getContext({ query: "release pipeline tagged commits" });
		if (typeof ctx === "string") throw new Error("the options form returns a ContextWindow");
		expect(ctx.memories.length).toBe(1);
		const ids = ctx.memories.map((m) => m.memoryId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("getStats counts the shared file once", async () => {
		const stats = await manager.getStats();
		expect(stats.project + stats.global).toBe(1);
	});
});
