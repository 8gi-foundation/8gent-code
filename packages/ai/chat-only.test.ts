/**
 * Chat-only messages (#4982): a deterministic check, then both loops run for real
 * on a stub provider: a chat-only message gets no tools on the first round, a task
 * message does.
 */
import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createEightAgent } from "./agent";
import { isChatOnly } from "./chat-only";
import { type TextTool, runTextToolAgent } from "./text-tool-loop";

describe("isChatOnly", () => {
	it("the spoken sentence from #4982 is chat-only", () => {
		expect(isChatOnly("I just wanted to hear the voice TTS")).toBe(true);
	});
	it("a greeting, a first-person statement, a question about 8gent", () => {
		expect(isChatOnly("hey there")).toBe(true);
		expect(isChatOnly("I want it faster")).toBe(true);
		expect(isChatOnly("what can you do?")).toBe(true);
		expect(isChatOnly("Who is 8gent?")).toBe(true);
	});
	it("thanks and goodbyes are chat-only, typed or spoken", () => {
		for (const t of ["thanks", "thank you so much", "bye", "good night"]) {
			expect(isChatOnly(t)).toBe(true);
			expect(isChatOnly(t, { spoken: true })).toBe(true);
		}
	});
	it("spoken questions about state still need the tools", () => {
		for (const t of [
			"are the tests passing",
			"why did it fail",
			"what does this error mean: ENOENT",
			"the voice sounds nice",
		]) {
			expect(isChatOnly(t, { spoken: true })).toBe(false);
			expect(isChatOnly(t)).toBe(false);
		}
		expect(isChatOnly("I just wanted to hear the voice TTS", { spoken: true })).toBe(true);
	});
	it("tasks are never chat-only, spoken or not", () => {
		for (const t of [
			"fix the login bug",
			"I need you to run the tests",
			"run the tests",
			"I like auth.ts, change it",
			"I want you to look at src/app.tsx",
			"hello, see https://8gent.dev",
			"hi `ls`",
			"hello && ls",
			"/help",
			"I want a ```code``` fence",
			"git status",
			"I want to ls -la",
			"x".repeat(121),
			"",
		]) {
			expect(isChatOnly(t)).toBe(false);
			expect(isChatOnly(t, { spoken: true })).toBe(false);
		}
	});
});

const CALL = ["```tool_call", JSON.stringify({ name: "probe", arguments: {} }), "```"].join("\n");
const probe: TextTool = {
	spec: { name: "probe", description: "p", parameters: { type: "object", properties: {} } },
	run: async () => "ok",
};

describe("text-tool loop", () => {
	function run(message: string) {
		const offered: number[] = [];
		let calls = 0;
		return {
			offered,
			go: () =>
				runTextToolAgent({
					messages: [{ role: "user", content: message }],
					tools: [probe],
					maxRounds: 6,
					chatOnlyFirstRound: isChatOnly(message),
					call: async (msgs) => {
						calls++;
						offered.push(
							msgs
								.map((m) => m.content)
								.join("\n")
								.includes("probe")
								? 1
								: 0,
						);
						return calls === 1 ? "Sure, the voice is on. Want to hear it?" : "DONE: ok";
					},
				}),
		};
	}

	it("a chat-only message: the first round has no tools and its reply is the answer", async () => {
		const r = run("I just wanted to hear the voice TTS");
		const out = await r.go();
		expect(out.content).toContain("Want to hear it?");
		expect(out.toolLog).toHaveLength(0);
		expect(r.offered).toEqual([0]);
	});

	it("a task message: the first round has the tools", async () => {
		const r = run("run the probe");
		await r.go();
		expect(r.offered[0]).toBe(1);
	});

	it("a chat-only reply that asks for a tool gets the round again with the tools", async () => {
		const seen: boolean[] = [];
		const out = await runTextToolAgent({
			messages: [{ role: "user", content: "I want to hear it" }],
			tools: [probe],
			maxRounds: 6,
			chatOnlyFirstRound: true,
			call: async (msgs) => {
				const hasTools = msgs
					.map((m) => m.content)
					.join("\n")
					.includes("probe");
				seen.push(hasTools);
				if (!hasTools) return CALL;
				return seen.length === 2 ? CALL : "DONE: played it";
			},
		});
		expect(seen[0]).toBe(false);
		expect(seen[1]).toBe(true);
		expect(out.toolLog.length).toBe(1);
	});
});

describe("native loop", () => {
	const usage = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	} as any;
	const probeTool = {
		probe: tool({
			description: "p",
			inputSchema: z.object({}).passthrough(),
			execute: async () => "ok",
		}),
	} as any;

	function build(chatOnlyFirstRound: boolean) {
		const choices: unknown[] = [];
		let n = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async (opts: any) => {
				n++;
				choices.push(opts.toolChoice);
				if (opts.toolChoice?.type === "none" || n > 1) {
					return {
						content: [{ type: "text", text: "finished" }],
						finishReason: { unified: "stop", raw: undefined },
						usage,
						warnings: [],
					} as any;
				}
				return {
					content: [{ type: "tool-call", toolCallId: "c1", toolName: "probe", input: "{}" }],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage,
					warnings: [],
				} as any;
			},
		});
		const agent = createEightAgent({
			provider: { name: "minimax", model: "mock" } as any,
			model: model as any,
			tools: probeTool,
			turnBudgetMs: 0,
			chatOnlyFirstRound,
		});
		return { agent, choices };
	}

	it("chat-only: the first step runs with tools off and its text ends the turn", async () => {
		const { agent, choices } = build(true);
		const out = await agent.generate({ prompt: "I just wanted to hear the voice TTS" });
		expect(out.text).toBe("finished");
		expect(choices).toEqual([{ type: "none" }]);
	});

	it("a task message: the first step has tools", async () => {
		const { agent, choices } = build(false);
		await agent.generate({ prompt: "run the probe" });
		expect((choices[0] as any)?.type).not.toBe("none");
	});
});
