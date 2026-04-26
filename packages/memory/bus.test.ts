/**
 * Tests for SharedMemoryBus — unified conversation + knowledge store.
 *
 * Covers:
 * 1. storeMessage stores and getConversation retrieves
 * 2. Scope isolation between different scopes
 * 3. getChannelConversation returns cross-scope messages
 * 4. remember stores semantic memory
 * 5. recall searches memories by keyword
 * 6. graph() returns working KnowledgeGraph
 * 7. health() returns valid MemoryHealth
 * 8. extractChannelPrefix handles various scope formats
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { type SharedMemoryBus, createSharedMemoryBus } from "./bus.js";

const TEST_DB = "/tmp/test-shared-bus.db";

let bus: SharedMemoryBus;

function cleanup() {
	for (const suffix of ["", "-wal", "-shm"]) {
		const p = TEST_DB + suffix;
		if (existsSync(p)) unlinkSync(p);
	}
}

describe("SharedMemoryBus", () => {
	beforeEach(() => {
		cleanup();
		bus = createSharedMemoryBus(TEST_DB);
	});

	afterEach(() => {
		cleanup();
	});

	// ── Test 1: storeMessage + getConversation ─────────────────────────

	it("stores messages and retrieves them in chronological order", () => {
		const scope = "discord:channel-1:8EO";

		bus.storeMessage("hello", "user", {
			source: "discord",
			scope,
			authorId: "u1",
			authorName: "James",
		});
		bus.storeMessage("hi there", "assistant", { source: "discord", scope });
		bus.storeMessage("how are you?", "user", {
			source: "discord",
			scope,
			authorId: "u1",
			authorName: "James",
		});

		const convo = bus.getConversation(scope);
		expect(convo).toHaveLength(3);
		expect(convo[0].content).toBe("hello");
		expect(convo[0].role).toBe("user");
		expect(convo[0].authorName).toBe("James");
		expect(convo[1].content).toBe("hi there");
		expect(convo[1].role).toBe("assistant");
		expect(convo[2].content).toBe("how are you?");
	});

	// ── Test 2: Scope isolation ────────────────────────────────────────

	it("isolates conversations by scope", () => {
		const scope1 = "discord:channel-1:8EO";
		const scope2 = "discord:channel-1:8TO";

		bus.storeMessage("from EO", "user", { source: "discord", scope: scope1 });
		bus.storeMessage("from TO", "user", { source: "discord", scope: scope2 });

		const convo1 = bus.getConversation(scope1);
		const convo2 = bus.getConversation(scope2);

		expect(convo1).toHaveLength(1);
		expect(convo1[0].content).toBe("from EO");
		expect(convo2).toHaveLength(1);
		expect(convo2[0].content).toBe("from TO");
	});

	// ── Test 3: getChannelConversation returns cross-scope ─────────────

	it("returns cross-scope messages for a channel prefix", () => {
		bus.storeMessage("msg from EO", "user", {
			source: "discord",
			scope: "discord:ch1:8EO",
		});
		bus.storeMessage("msg from TO", "user", {
			source: "discord",
			scope: "discord:ch1:8TO",
		});
		bus.storeMessage("msg from other channel", "user", {
			source: "discord",
			scope: "discord:ch2:8EO",
		});

		const channel = bus.getChannelConversation("discord:ch1");
		expect(channel).toHaveLength(2);
		expect(channel.map((c) => c.content).sort()).toEqual([
			"msg from EO",
			"msg from TO",
		]);
	});

	// ── Test 4: remember stores semantic memory ────────────────────────

	it("stores a semantic memory retrievable from database", () => {
		const id = bus.remember(
			"TypeScript is preferred over JavaScript",
			"semantic",
			{
				source: "cli",
				scope: "global",
				importance: 0.8,
				tags: ["preference", "language"],
			},
		);

		expect(id).toBeTruthy();
		expect(id.startsWith("mem_")).toBe(true);

		// Verify it's in the database
		const db = bus.database();
		const row = db
			.prepare("SELECT content_text FROM memories WHERE id = ?")
			.get(id) as any;
		expect(row).toBeTruthy();
	});

	// ── Test 5: recall searches memories ───────────────────────────────

	it("recalls memories matching a keyword search", async () => {
		bus.remember("Redis is used for caching session tokens", "semantic", {
			source: "discord",
			scope: "discord:ch1:8TO",
		});
		bus.remember("PostgreSQL is the primary database", "semantic", {
			source: "discord",
			scope: "discord:ch1:8TO",
		});
		bus.remember("The weather is nice today", "episodic", {
			source: "telegram",
			scope: "telegram:chat-1",
		});

		const results = await bus.recall("database");
		expect(results.length).toBeGreaterThanOrEqual(1);
		const contents = results.map((r) => r.content);
		expect(contents.some((c) => c.includes("PostgreSQL"))).toBe(true);
	});

	// ── Test 6: graph() returns working KnowledgeGraph ─────────────────

	it("returns a working KnowledgeGraph instance", () => {
		const graph = bus.graph();
		const entityId = graph.addEntity("concept", "memory-bus");
		const entity = graph.getEntity(entityId);

		expect(entity).toBeTruthy();
		expect(entity?.name).toBe("memory-bus");
		expect(entity?.type).toBe("concept");
	});

	// ── Test 7: health() returns valid MemoryHealth ────────────────────

	it("returns health with score 0-100", () => {
		const h = bus.health();
		expect(h.healthScore).toBeGreaterThanOrEqual(0);
		expect(h.healthScore).toBeLessThanOrEqual(100);
		expect(typeof h.totalCount).toBe("number");
	});

	// ── Test 8: channel prefix extraction ──────────────────────────────

	it("correctly handles two-segment scopes without trimming", () => {
		bus.storeMessage("telegram msg", "user", {
			source: "telegram",
			scope: "telegram:chat-456",
		});

		// Two-segment scope: channel prefix IS the full scope
		const convo = bus.getChannelConversation("telegram:chat-456");
		expect(convo).toHaveLength(1);
		expect(convo[0].content).toBe("telegram msg");
	});
});
