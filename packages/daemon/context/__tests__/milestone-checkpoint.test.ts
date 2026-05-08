/**
 * Tests for MilestoneCheckpointer (issue #2420).
 *
 * Verifies the trigger logic: token pressure vs natural breakpoints, and
 * that registry + previous summary chain through repeated checkpoints.
 */

import { describe, expect, it } from "bun:test";
import { ArtifactRegistryStore } from "../artifact-registry";
import { CompressionEngine } from "../compression-engine";
import { ContextTracker } from "../context-tracker";
import type { Message, SummarizerCall } from "../index";
import { MilestoneCheckpointer } from "../milestone-checkpoint";

function bigContent(size = 200): string {
	return "x ".repeat(size);
}

function buildHistory(turns: number): Message[] {
	const messages: Message[] = [{ role: "system", content: "system prompt" }];
	for (let i = 0; i < turns; i++) {
		messages.push({
			role: i % 2 === 0 ? "user" : "assistant",
			content: bigContent(150),
		});
	}
	return messages;
}

function makeStub(text = "[summary]"): SummarizerCall {
	return async () => ({ text });
}

describe("MilestoneCheckpointer", () => {
	it("does nothing when neither pressure nor milestone fires", async () => {
		const tracker = new ContextTracker({ contextWindow: 100000 });
		const registry = new ArtifactRegistryStore();
		const engine = new CompressionEngine(makeStub(), { keepRecentTokens: 200 });
		const checkpointer = new MilestoneCheckpointer(engine, tracker, registry);

		const result = await checkpointer.maybeCheckpoint(buildHistory(20));
		expect(result.checkpointed).toBe(false);
		expect(result.reason).toBe("none");
	});

	it("triggers on token pressure crossing the threshold", async () => {
		const tracker = new ContextTracker({ contextWindow: 1000 });
		tracker.recordInput(800);
		const registry = new ArtifactRegistryStore();
		const engine = new CompressionEngine(makeStub(), { keepRecentTokens: 200 });
		const checkpointer = new MilestoneCheckpointer(engine, tracker, registry, {
			nearLimitThreshold: 0.75,
		});

		const result = await checkpointer.maybeCheckpoint(buildHistory(20));
		expect(result.checkpointed).toBe(true);
		expect(result.reason).toBe("near-limit");
		expect(result.checkpoint?.messagesRemoved).toBeGreaterThan(0);
	});

	it("triggers on a milestone event after enough new messages", async () => {
		const tracker = new ContextTracker({ contextWindow: 100000 });
		const registry = new ArtifactRegistryStore();
		const engine = new CompressionEngine(makeStub(), { keepRecentTokens: 200 });
		const checkpointer = new MilestoneCheckpointer(engine, tracker, registry, {
			minMessagesBetweenCheckpoints: 4,
		});

		checkpointer.recordEvent({ type: "task-complete", description: "phase 1" });
		const result = await checkpointer.maybeCheckpoint(buildHistory(20));
		expect(result.checkpointed).toBe(true);
		expect(result.reason).toBe("milestone");
	});

	it("debounces milestone events under minMessagesBetweenCheckpoints", async () => {
		const tracker = new ContextTracker({ contextWindow: 100000 });
		const registry = new ArtifactRegistryStore();
		const engine = new CompressionEngine(makeStub(), { keepRecentTokens: 200 });
		const checkpointer = new MilestoneCheckpointer(engine, tracker, registry, {
			minMessagesBetweenCheckpoints: 100,
		});

		checkpointer.recordEvent({ type: "tool-success", toolName: "write_file" });
		const result = await checkpointer.maybeCheckpoint(buildHistory(10));
		expect(result.checkpointed).toBe(false);
		expect(result.reason).toBe("none");
	});

	it("chains summaries across checkpoints (incremental)", async () => {
		const tracker = new ContextTracker({ contextWindow: 1000 });
		tracker.recordInput(800);
		const registry = new ArtifactRegistryStore();

		const seenPrompts: string[] = [];
		const engine = new CompressionEngine(
			async ({ prompt }) => {
				seenPrompts.push(prompt);
				return { text: `summary-${seenPrompts.length}` };
			},
			{ keepRecentTokens: 200 },
		);
		const checkpointer = new MilestoneCheckpointer(engine, tracker, registry);

		const first = await checkpointer.maybeCheckpoint(buildHistory(20));
		expect(first.checkpointed).toBe(true);

		// Advance pressure again so a second pass fires.
		tracker.recordInput(800);
		const more = first.messages
			? [...first.messages, ...buildHistory(20).slice(1)]
			: buildHistory(20);
		const second = await checkpointer.maybeCheckpoint(more);
		expect(second.checkpointed).toBe(true);
		expect(seenPrompts.length).toBe(2);
		// Second prompt feeds the first summary back in (incremental).
		expect(seenPrompts[1]).toContain("summary-1");
		expect(seenPrompts[1]).toContain("Update");
	});

	it("forceCheckpoint runs unconditionally", async () => {
		const tracker = new ContextTracker({ contextWindow: 100000 });
		const registry = new ArtifactRegistryStore();
		const engine = new CompressionEngine(makeStub(), { keepRecentTokens: 200 });
		const checkpointer = new MilestoneCheckpointer(engine, tracker, registry);

		const result = await checkpointer.forceCheckpoint(buildHistory(20));
		expect(result.reason).toBe("manual");
		expect(result.checkpoint).toBeDefined();
	});

	it("resets the tracker after a successful compression", async () => {
		const tracker = new ContextTracker({ contextWindow: 1000 });
		tracker.recordInput(800);
		const registry = new ArtifactRegistryStore();
		const engine = new CompressionEngine(makeStub(), { keepRecentTokens: 200 });
		const checkpointer = new MilestoneCheckpointer(engine, tracker, registry);

		await checkpointer.maybeCheckpoint(buildHistory(20));
		expect(tracker.getUsage().total).toBeLessThan(800);
	});
});
