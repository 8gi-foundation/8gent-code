/**
 * Tests for SessionContextManager (issue #2420).
 *
 * Smoke-test the bundled facade that AgentPool uses. Verifies that the
 * tracker, registry, and checkpointer compose correctly end to end.
 */

import { describe, expect, it } from "bun:test";
import type { Message, SummarizerCall } from "../index";
import { SessionContextManager } from "../session-context-manager";

const stubSummarize: SummarizerCall = async () => ({ text: "[summary]" });

function buildHistory(turns: number): Message[] {
	const messages: Message[] = [{ role: "system", content: "system" }];
	for (let i = 0; i < turns; i++) {
		messages.push({
			role: i % 2 === 0 ? "user" : "assistant",
			content: `${"x ".repeat(150)}referenced packages/daemon/context/types.ts`,
		});
	}
	return messages;
}

describe("SessionContextManager", () => {
	it("composes tracker, registry, and checkpointer", () => {
		const mgr = new SessionContextManager({
			contextWindow: 8000,
			summarize: stubSummarize,
		});
		const status = mgr.getStatus();
		expect(status.tracker.contextWindow).toBe(8000);
		expect(status.registry.files).toBe(0);
		expect(status.checkpoints).toBe(0);
	});

	it("maybeCompress is a no-op when tracker is well below threshold", async () => {
		const mgr = new SessionContextManager({
			contextWindow: 1000000,
			summarize: stubSummarize,
		});
		const result = await mgr.maybeCompress(buildHistory(5));
		expect(result.checkpointed).toBe(false);
		// But it still ingests artifacts on the way through.
		expect(mgr.getStatus().registry.files).toBeGreaterThan(0);
	});

	it("compresses, restores, and resets the tracker when near limit", async () => {
		const mgr = new SessionContextManager({
			contextWindow: 1000,
			summarize: stubSummarize,
			keepRecentTokens: 200,
			nearLimitThreshold: 0.75,
		});
		mgr.recordExchange(800, 0);
		expect(mgr.getStatus().tracker.ratio).toBeGreaterThan(0.75);

		const result = await mgr.maybeCompress(buildHistory(20));
		expect(result.checkpointed).toBe(true);
		expect(result.messages).toBeDefined();
		expect(result.checkpoint?.tokensAfter).toBeLessThan(result.checkpoint?.tokensBefore ?? 0);

		// Tracker should now reflect the post-compression load.
		expect(mgr.getStatus().tracker.ratio).toBeLessThan(0.75);
	});

	it("milestone events feed through to the checkpointer", async () => {
		const mgr = new SessionContextManager({
			contextWindow: 1000000,
			summarize: stubSummarize,
			keepRecentTokens: 200,
			minMessagesBetweenCheckpoints: 3,
		});
		mgr.recordMilestone({ type: "test-passed", suite: "unit" });
		const result = await mgr.maybeCompress(buildHistory(10));
		expect(result.checkpointed).toBe(true);
		expect(result.reason).toBe("milestone");
	});
});
