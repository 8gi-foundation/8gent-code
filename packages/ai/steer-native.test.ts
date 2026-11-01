/**
 * D1 steering on the native (AI SDK) loop. The SDK rebuilds each step's
 * messages from the run's input plus its responses, so a prepareStep override
 * holds for one step only. steerMessages must splice each steer back in at the
 * same place on every later step. Runs the real ToolLoopAgent on a mock model.
 */
import { describe, expect, test } from "bun:test";
import { type ModelMessage, ToolLoopAgent, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { type SteerEntry, steerMessages } from "./agent";

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function toolCall(id: string) {
	return {
		content: [{ type: "tool-call" as const, toolCallId: id, toolName: "probe", input: "{}" }],
		finishReason: { unified: "tool-calls" as const, raw: undefined },
		usage,
		warnings: [],
	};
}

describe("steerMessages", () => {
	test("a steer sent during a tool call reaches every later step, once, after that tool's result", async () => {
		const queue: string[] = [];
		const prompts: unknown[][] = [];
		let step = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async (opts) => {
				prompts.push(opts.prompt as unknown[]);
				step++;
				if (step === 1) return toolCall("c1");
				if (step === 2) return toolCall("c2");
				return {
					content: [{ type: "text" as const, text: "done" }],
					finishReason: { unified: "stop" as const, raw: undefined },
					usage,
					warnings: [],
				};
			},
		});
		const log: SteerEntry[] = [];
		let probes = 0;
		const agent = new ToolLoopAgent({
			model,
			tools: {
				probe: tool({
					inputSchema: jsonSchema({ type: "object", properties: {} }),
					execute: async () => {
						probes++;
						// The person steers while the first tool call runs.
						if (probes === 1) queue.push("STEER_NATIVE");
						return `result ${probes}`;
					},
				}),
			},
			stopWhen: stepCountIs(5),
			prepareStep: async ({
				stepNumber,
				messages,
			}: { stepNumber: number; messages: ModelMessage[] }) => {
				const steered = steerMessages(log, stepNumber, messages, () => queue.splice(0));
				return steered ? { messages: steered } : undefined;
			},
		});
		await agent.generate({ messages: [{ role: "user", content: "go" }] });

		expect(prompts).toHaveLength(3);
		const roles = (p: unknown[]) => (p as Array<{ role: string }>).map((m) => m.role);
		const hasSteer = (m: unknown) => JSON.stringify(m).includes("STEER_NATIVE");
		// Step 0: not there yet.
		expect(prompts[0].some(hasSteer)).toBe(false);
		// Step 1: the last message, right after the first tool result.
		expect(roles(prompts[1])).toEqual(["user", "assistant", "tool", "user"]);
		expect(hasSteer(prompts[1][3])).toBe(true);
		// Step 2: still there, once, in the same place, with the next round after it.
		expect(roles(prompts[2])).toEqual(["user", "assistant", "tool", "user", "assistant", "tool"]);
		expect(prompts[2].filter(hasSteer)).toHaveLength(1);
		expect(hasSteer(prompts[2][3])).toBe(true);
	});

	test("nothing queued leaves the step unchanged, and step 0 starts a fresh log", () => {
		const log: SteerEntry[] = [{ at: 1, message: { role: "user", content: "stale" } }];
		const msgs: ModelMessage[] = [{ role: "user", content: "go" }];
		expect(steerMessages(log, 0, msgs, () => ["never drained at step 0"])).toBeUndefined();
		expect(log).toHaveLength(0);
		expect(steerMessages(log, 1, msgs, () => [])).toBeUndefined();
	});

	test("two steers at different steps keep their own positions", () => {
		const log: SteerEntry[] = [];
		const a: ModelMessage[] = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: "a1" },
		];
		steerMessages(log, 1, a, () => ["S1"]);
		const b: ModelMessage[] = [...a, { role: "assistant", content: "a2" }];
		const out = steerMessages(log, 2, b, () => ["S2"]) as ModelMessage[];
		expect(out.map((m) => m.content)).toEqual(["go", "a1", "S1", "a2", "S2"]);
	});
});
