/**
 * LocalHarness ("8gent-local") - the default backend (part of #2797).
 *
 * The engine is injected through the createEngine seam so the suite drives the
 * REAL event bridging (AgentEventCallbacks -> StatusEvent) without needing a
 * live local model. The default engine (no options) is the real packages/eight
 * Agent; that path is exercised by the lazy-import test below.
 *
 * Covers:
 *   - lifecycle: queued -> working -> done, in order, with the final output
 *   - tool events surface as working events with the real tool name
 *   - step usage surfaces as cumulative real token counts
 *   - elapsedMs is present and monotonically sensible on terminal events
 *   - engine failure ends the stream with a single error event
 *   - no fabricated numbers: events from an engine that reports nothing
 *     carry no tokens and no tool fields
 */

import { describe, expect, it } from "bun:test";
import type { AgentEventCallbacks } from "../../eight/types";
import type { StatusEvent } from "../index";
import { LocalHarness } from "../local";

async function collect(iter: AsyncIterable<StatusEvent>): Promise<StatusEvent[]> {
	const out: StatusEvent[] = [];
	for await (const e of iter) out.push(e);
	return out;
}

function stepUsage(totalTokens: number) {
	return {
		stepNumber: 1,
		finishReason: "stop",
		text: "",
		toolCalls: [],
		usage: { promptTokens: 0, completionTokens: 0, totalTokens },
	};
}

describe("LocalHarness", () => {
	it("has the default harness name 8gent-local", () => {
		expect(new LocalHarness().name).toBe("8gent-local");
	});

	it("streams queued -> working -> done with the real output", async () => {
		const harness = new LocalHarness({
			createEngine: () => ({ chat: async () => "the answer" }),
		});
		const events = await collect(harness.run({ id: "t1", prompt: "hi" }));

		expect(events[0]?.state).toBe("queued");
		expect(events[1]?.state).toBe("working");
		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.output).toBe("the answer");
		for (const e of events) {
			expect(e.agentId).toBe("t1");
			expect(e.harness).toBe("8gent-local");
			expect(typeof e.ts).toBe("number");
		}
	});

	it("surfaces real tool activity as working events with the tool name", async () => {
		const harness = new LocalHarness({
			createEngine: ({ events }: { events: AgentEventCallbacks }) => ({
				chat: async () => {
					events.onToolStart?.({ toolName: "read_file", toolCallId: "c1", args: {} });
					return "done reading";
				},
			}),
		});
		const events = await collect(harness.run({ id: "t2", prompt: "read something" }));
		const toolEvent = events.find((e) => e.tool === "read_file");
		expect(toolEvent).toBeDefined();
		expect(toolEvent?.state).toBe("working");
	});

	it("reports cumulative real token usage from step events", async () => {
		const harness = new LocalHarness({
			createEngine: ({ events }: { events: AgentEventCallbacks }) => ({
				chat: async () => {
					events.onStepFinish?.(stepUsage(120));
					events.onStepFinish?.(stepUsage(80));
					return "ok";
				},
			}),
		});
		const events = await collect(harness.run({ id: "t3", prompt: "count" }));
		const tokenEvents = events.filter((e) => typeof e.tokens === "number");
		expect(tokenEvents.length).toBe(3); // two step events + done carries the total
		expect(tokenEvents[0]?.tokens).toBe(120);
		expect(tokenEvents[1]?.tokens).toBe(200);
		const last = events[events.length - 1];
		expect(last?.state).toBe("done");
		expect(last?.tokens).toBe(200);
	});

	it("stamps elapsedMs on the terminal event", async () => {
		const harness = new LocalHarness({
			createEngine: () => ({ chat: async () => "quick" }),
		});
		const events = await collect(harness.run({ id: "t4", prompt: "go" }));
		const last = events[events.length - 1];
		expect(typeof last?.elapsedMs).toBe("number");
		expect(last?.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("ends with a single error event when the engine throws", async () => {
		const harness = new LocalHarness({
			createEngine: () => ({
				chat: async () => {
					throw new Error("model exploded");
				},
			}),
		});
		const events = await collect(harness.run({ id: "t5", prompt: "boom" }));
		const errors = events.filter((e) => e.state === "error");
		expect(errors.length).toBe(1);
		expect(events[events.length - 1]?.state).toBe("error");
		expect(errors[0]?.output).toContain("model exploded");
		expect(events.some((e) => e.state === "done")).toBe(false);
	});

	it("never fabricates numbers: silent engine yields no tokens and no tool", async () => {
		const harness = new LocalHarness({
			createEngine: () => ({ chat: async () => "silent" }),
		});
		const events = await collect(harness.run({ id: "t6", prompt: "hush" }));
		for (const e of events) {
			expect(e.tokens).toBeUndefined();
			expect(e.tool).toBeUndefined();
		}
	});

	it("default engine factory lazily resolves the real packages/eight Agent", async () => {
		// Proves the default (no-options) path is wired to the real Agent class,
		// without invoking a live model.
		const { defaultEngineFactoryTarget } = await import("../local");
		const { Agent } = await import("../../eight/agent");
		expect(await defaultEngineFactoryTarget()).toBe(Agent);
	});
});
