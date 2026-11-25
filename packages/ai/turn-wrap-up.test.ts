/**
 * Termux report, 7 Nov: a turn used 48 tool calls and 592K tokens, then stopped at the cap
 * with no answer. Three calls before the cap the model is told to answer with no tools.
 */
import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createEightAgent } from "./agent";
import { wrapUpNoteForSteps } from "./turn-guards";

describe("wrap-up before the tool-call cap", () => {
	it("the note appears three calls before the cap, not earlier, and never for tiny or off caps", () => {
		const steps = (n: number) =>
			Array.from({ length: n }, () => ({ toolCalls: [{ toolName: "a" }] }));
		const limits = { toolCap: 48, blocks: 0, tokens: 0 };
		expect(wrapUpNoteForSteps(steps(44), limits)).toBeNull();
		expect(wrapUpNoteForSteps(steps(45), limits)).toContain("45 of 48 tool calls");
		expect(wrapUpNoteForSteps(steps(45), { ...limits, toolCap: 0 })).toBeNull();
		expect(wrapUpNoteForSteps(steps(3), { ...limits, toolCap: 3 })).toBeNull();
	});

	it("a model told 'no tools' ends the turn with an answer, not the stop line", async () => {
		let n = 0;
		const seenChoices: unknown[] = [];
		const model = new MockLanguageModelV3({
			doGenerate: async (options: any) => {
				n++;
				seenChoices.push(options.toolChoice?.type);
				const noTools = options.toolChoice?.type === "none";
				return {
					content: noTools
						? [{ type: "text", text: "Here is what I found: the config is in a.ts." }]
						: [
								{
									type: "tool-call",
									toolCallId: `c${n}`,
									toolName: "probe",
									input: JSON.stringify({ command: `cmd ${n}` }),
								},
							],
					finishReason: noTools
						? { unified: "stop", raw: undefined }
						: { unified: "tool-calls", raw: undefined },
					usage: {
						inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 5, text: 5, reasoning: 0 },
					} as any,
					warnings: [],
				} as any;
			},
		});
		const turnStop = { line: null as string | null };
		const agent = createEightAgent({
			provider: { name: "minimax", model: "mock" } as any,
			model: model as any,
			tools: {
				probe: tool({
					description: "p",
					inputSchema: z.object({}).passthrough(),
					execute: async () => "ok",
				}),
			},
			maxSteps: 500,
			turnBudgetMs: 0,
			turnLimits: { toolCap: 48, blocks: 3, tokens: 0 },
			turnStop,
		});
		const out = await agent.generate({ prompt: "find the config" });
		expect(out.text).toContain("Here is what I found");
		expect(turnStop.line).toBeNull();
		expect(n).toBe(46);
		expect(seenChoices.at(-1)).toBe("none");
	});
});
