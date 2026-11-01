/**
 * Silent tool calls (#4791): N tool calls with no prose in between end tool use
 * for one reply, which reports and asks whether to keep going. Both loops run for
 * real here: the text-tool loop on a scripted model, the native loop on the AI
 * SDK's mock model.
 */
import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createEightAgent } from "./agent";
import {
	DEFAULT_SILENT_CALLS,
	MIN_PROSE_CHARS,
	SilentCalls,
	resolveSilentCalls,
	silentCallsNoteForSteps,
} from "./silent-calls";
import { type TextTool, runTextToolAgent } from "./text-tool-loop";

describe("resolveSilentCalls", () => {
	it("is on at 8 by default, off at 0 or off, and takes an integer from 2", () => {
		expect(resolveSilentCalls({})).toBe(DEFAULT_SILENT_CALLS);
		expect(DEFAULT_SILENT_CALLS).toBe(8);
		expect(resolveSilentCalls({ EIGHT_SILENT_CALLS: "0" })).toBe(0);
		expect(resolveSilentCalls({ EIGHT_SILENT_CALLS: "off" })).toBe(0);
		expect(resolveSilentCalls({ EIGHT_SILENT_CALLS: "1" })).toBe(0);
		expect(resolveSilentCalls({ EIGHT_SILENT_CALLS: "12" })).toBe(12);
	});
});

describe("SilentCalls", () => {
	const say = "x".repeat(MIN_PROSE_CHARS);
	it("trips at the threshold, and real prose between calls resets the count", () => {
		const s = new SilentCalls(4);
		s.round("", ["a", "b", "c"]);
		expect(s.tripped()).toBe(false);
		s.round("Let me check.", ["d"]);
		expect(s.tripped()).toBe(true);
		const r = new SilentCalls(4);
		r.round("", ["a", "b", "c"]);
		r.round(say, ["d"]);
		expect(r.count).toBe(1);
		expect(r.tripped()).toBe(false);
	});
	it("a threshold of 0 never trips", () => {
		const s = new SilentCalls(0);
		s.round("", Array(50).fill("a"));
		expect(s.tripped()).toBe(false);
	});
	it("the note names the count and the tools, and asks whether to keep going", () => {
		const note = silentCallsNoteForSteps(
			[{ text: "", toolCalls: [{ toolName: "run_command" }, { toolName: "read_file" }] }],
			2,
		);
		expect(note).toContain("2 tool calls");
		expect(note).toContain("run_command, read_file");
		expect(note).toContain("whether to keep going");
		expect(silentCallsNoteForSteps([{ text: "", toolCalls: [{ toolName: "a" }] }], 2)).toBeNull();
	});
});

const CALL = (n: number) =>
	["```tool_call", JSON.stringify({ name: "probe", arguments: { n } }), "```"].join("\n");

describe("text-tool loop", () => {
	const probe: TextTool = {
		spec: { name: "probe", description: "p", parameters: { type: "object", properties: {} } },
		run: async (args) => `result ${JSON.stringify(args)}`,
	};

	it("8 silent calls end tool use for one reply that is the turn's answer", async () => {
		let calls = 0;
		const lastSeen: string[] = [];
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "why the slash ain't working" }],
			tools: [probe],
			maxRounds: 30,
			silentCalls: 8,
			call: async (msgs) => {
				calls++;
				const last = msgs[msgs.length - 1].content;
				lastSeen.push(last);
				if (last.includes("tool calls in a row without telling the person")) {
					return "So far I looked at 8 places and found nothing. Want me to keep going?";
				}
				return CALL(calls);
			},
		});
		expect(calls).toBe(9);
		expect(result.toolLog).toHaveLength(8);
		expect(result.content).toContain("Want me to keep going?");
		expect(lastSeen[8]).toContain("Tools are not available for this reply");
	});

	it("prose between calls keeps the turn going past 8", async () => {
		let calls = 0;
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [probe],
			maxRounds: 30,
			silentCalls: 8,
			call: async () => {
				calls++;
				if (calls > 12) return "DONE: all twelve finished";
				return `Step ${calls} is done, moving to the next one now.\n${CALL(calls)}`;
			},
		});
		expect(result.toolLog).toHaveLength(12);
		expect(result.content).toContain("all twelve finished");
	});

	it("carry-on (yolo, Infinite): a progress line at the threshold, tools stay on, no question", async () => {
		let calls = 0;
		const lines: string[] = [];
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [probe],
			maxRounds: 40,
			silentCalls: 4,
			silentProgress: (l) => lines.push(l),
			call: async (msgs) => {
				calls++;
				expect(msgs[msgs.length - 1].content).not.toContain("tool calls in a row without telling");
				return calls > 10 ? "DONE: ten silent calls ran" : CALL(calls);
			},
		});
		expect(result.toolLog).toHaveLength(10);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Still working: 4 steps so far (probe). Carrying on.");
		expect(result.content).toContain("ten silent calls ran");
	});

	it("off (0) leaves a long silent run alone", async () => {
		let calls = 0;
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [probe],
			maxRounds: 30,
			silentCalls: 0,
			call: async () => {
				calls++;
				return calls > 10 ? "DONE: ten silent calls ran" : CALL(calls);
			},
		});
		expect(result.toolLog).toHaveLength(10);
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

	function build(silentCalls: number | undefined, silentProgress?: (l: string) => void) {
		const choices: unknown[] = [];
		let calls = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async (opts: any) => {
				calls++;
				choices.push(opts.toolChoice);
				if (JSON.stringify(opts.prompt).includes("tool calls in a row without telling")) {
					return {
						content: [{ type: "text", text: "Looked in 4 places, nothing yet. Keep going?" }],
						finishReason: { unified: "stop", raw: undefined },
						usage,
						warnings: [],
					} as any;
				}
				if (calls > 10) {
					return {
						content: [{ type: "text", text: "finished" }],
						finishReason: { unified: "stop", raw: undefined },
						usage,
						warnings: [],
					} as any;
				}
				return {
					content: [{ type: "tool-call", toolCallId: `c${calls}`, toolName: "probe", input: "{}" }],
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
			maxSteps: 30,
			turnBudgetMs: 0,
			silentCalls,
			silentProgress,
		});
		return { agent, choices, calls: () => calls };
	}

	it("4 silent tool calls: the next step runs with tools off and its text ends the turn", async () => {
		const { agent, choices, calls } = build(4);
		const out = await agent.generate({ prompt: "why the slash ain't working" });
		expect(calls()).toBe(5);
		expect(out.text).toContain("Keep going?");
		expect(choices[4]).toEqual({ type: "none" });
		expect(choices.slice(0, 4).every((c) => (c as any)?.type !== "none")).toBe(true);
	});

	it("carry-on: progress lines every 4 silent calls, tools never turned off, the run finishes itself", async () => {
		const lines: string[] = [];
		const { agent, choices, calls } = build(4, (l) => lines.push(l));
		const out = await agent.generate({ prompt: "go" });
		expect(out.text).toBe("finished");
		expect(calls()).toBe(11);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Still working: 4 steps so far (probe)");
		expect(choices.some((c) => (c as any)?.type === "none")).toBe(false);
	});

	it("unset leaves the loop alone: ten calls then the model's own answer", async () => {
		const { agent, calls } = build(undefined);
		const out = await agent.generate({ prompt: "go" });
		expect(calls()).toBe(11);
		expect(out.text).toBe("finished");
	});
});
