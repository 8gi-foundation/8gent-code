/**
 * MemoryStore - basic operation tests
 *
 * Covers: write, get, recall, update, forget, batch write.
 * Uses tmp SQLite file, cleaned up after each test.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "./store.js";
import { type Memory, type MemoryType, generateId } from "./types.js";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_DB = join(tmpdir(), `memory-test-${Date.now()}.db`);

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: generateId(),
    type: "episodic" as MemoryType,
    scope: "session",
    data: { text: "test memory content" },
    contentText: overrides.contentText ?? "test memory content",
    tags: ["test"],
    importance: 0.5,
    decayFactor: 1.0,
    accessCount: 0,
    version: 1,
    source: "test",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(TEST_DB);
  });

  afterEach(() => {
    try {
      if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
      if (existsSync(TEST_DB + "-wal")) unlinkSync(TEST_DB + "-wal");
      if (existsSync(TEST_DB + "-shm")) unlinkSync(TEST_DB + "-shm");
    } catch {}
  });

  test("write and get a memory", () => {
    const mem = makeMemory({ contentText: "hello world" });
    const id = store.write(mem);
    expect(id).toBe(mem.id);

    const retrieved = store.get(id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.contentText).toBe("hello world");
  });

  test("get returns null for missing id", () => {
    expect(store.get("nonexistent-id")).toBeNull();
  });

  test("writeBatch stores multiple memories", () => {
    const mems = [makeMemory(), makeMemory(), makeMemory()];
    const ids = store.writeBatch(mems);
    expect(ids).toHaveLength(3);

    for (const id of ids) {
      expect(store.get(id)).not.toBeNull();
    }
  });

  test("recall finds memories by text query", async () => {
    store.write(makeMemory({ contentText: "the quick brown fox" }));
    store.write(makeMemory({ contentText: "lazy dog sleeps" }));

    const results = await store.recall("fox");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.memory.contentText.includes("fox"))).toBe(true);
  });

  test("forget soft-deletes a memory", () => {
    const mem = makeMemory();
    store.write(mem);
    const deleted = store.forget(mem.id, "test cleanup");
    expect(deleted).toBe(true);

    expect(store.get(mem.id)).toBeNull();
  });

  test("forget returns false for missing id", () => {
    expect(store.forget("nonexistent")).toBe(false);
  });
});
