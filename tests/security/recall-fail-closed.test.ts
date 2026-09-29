/**
 * Finding: SemanticRecall caught every error and returned []. To every caller
 * that is identical to "there are no memories": an unreadable store, a corrupt
 * FTS index or schema drift all arrived as an empty array, recallAsText()
 * returned "" and the agent silently reasoned over an empty world.
 *
 * Fix: PR 2984 (commit c621f895, SemanticRecall throws MemoryRecallError).
 * credit: Artale (8SO)
 *
 * The error is checked by name rather than by importing MemoryRecallError, so
 * on code without the fix the test fails on behaviour ([] instead of a throw)
 * and not on a missing import.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No network: SemanticRecall warms embeddings against a local Ollama on construction.
const realEmbeddings = await import("../../packages/memory/embeddings.ts");
mock.module("../../packages/memory/embeddings.ts", () => ({
	...realEmbeddings,
	getEmbeddingProvider: async () => new realEmbeddings.NullEmbeddingProvider(),
}));

const { MemoryStore } = await import("../../packages/memory/store.ts");
const { SemanticRecall } = await import("../../packages/memory/recall.ts");

let dir = "";

async function outcome(fn: () => Promise<unknown>): Promise<{ value?: unknown; error?: Error }> {
	try {
		return { value: await fn() };
	} catch (error) {
		return { error: error as Error };
	}
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "eight-sec-recall-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("recall fails closed (PR 2984)", () => {
	test("a healthy, empty store returns [] and does not throw", async () => {
		const store = new MemoryStore(join(dir, "healthy.db"));
		const r = await outcome(() => new SemanticRecall(store).recall("flaky test retry"));
		store.close();
		expect(r.error).toBeUndefined();
		expect(r.value).toEqual([]);
	});

	test("a broken store (closed database) throws MemoryRecallError, not []", async () => {
		const store = new MemoryStore(join(dir, "closed.db"));
		const recall = new SemanticRecall(store);
		store.close();
		const r = await outcome(() => recall.recall("flaky test retry"));
		expect(r.value).toBeUndefined();
		expect(r.error?.name).toBe("MemoryRecallError");
	});

	test("a broken store (memories table dropped under it) throws MemoryRecallError, not []", async () => {
		const store = new MemoryStore(join(dir, "dropped.db"));
		const recall = new SemanticRecall(store);
		store.db.exec("DROP TABLE IF EXISTS memories_fts");
		store.db.exec("DROP TABLE memories");
		const r = await outcome(() => recall.recall("flaky test retry"));
		store.close();
		expect(r.value).toBeUndefined();
		expect(r.error?.name).toBe("MemoryRecallError");
	});

	test("recallAsText propagates the failure instead of returning an empty string", async () => {
		const store = new MemoryStore(join(dir, "text.db"));
		const recall = new SemanticRecall(store);
		store.close();
		const r = await outcome(() => recall.recallAsText("flaky test retry"));
		expect(r.value).toBeUndefined();
		expect(r.error?.name).toBe("MemoryRecallError");
	});
});
