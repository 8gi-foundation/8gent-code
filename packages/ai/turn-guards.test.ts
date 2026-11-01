/**
 * Per-turn limits (#4982), on the production call shape: a stub provider that
 * keeps returning tool calls, through both loops, in Infinite (carry-on) mode.
 */
import { describe, expect, it } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createEightAgent, gateTools } from "./agent";
import { type TextTool, runTextToolAgent } from "./text-tool-loop";
import {
	DEFAULT_TURN_BLOCKS,
	DEFAULT_TURN_TOOL_CAP,
	TurnGuard,
	blockedReasonOf,
	resolveTurnBlocks,
	resolveTurnLimits,
	resolveTurnTokens,
	resolveTurnToolCap,
	turnStopForSteps,
} from "./turn-guards";

describe("flags", () => {
	it("cap 48, blocks 3, tokens half the window; 0 or off turns each off", () => {
		expect(resolveTurnToolCap({})).toBe(DEFAULT_TURN_TOOL_CAP);
		expect(DEFAULT_TURN_TOOL_CAP).toBe(48);
		expect(resolveTurnToolCap({ EIGHT_TURN_TOOL_CAP: "0" })).toBe(0);
		expect(resolveTurnToolCap({ EIGHT_TURN_TOOL_CAP: "100" })).toBe(100);
		expect(resolveTurnToolCap({ EIGHT_TURN_TOOL_CAP: "junk" })).toBe(48);
		expect(resolveTurnBlocks({})).toBe(DEFAULT_TURN_BLOCKS);
		expect(resolveTurnBlocks({ EIGHT_TURN_BLOCKS: "off" })).toBe(0);
		expect(resolveTurnTokens(200_000, {})).toBe(100_000);
		expect(resolveTurnTokens(0, {})).toBe(0);
		expect(resolveTurnTokens(200_000, { EIGHT_TURN_TOKENS: "5000" })).toBe(5000);
		expect(resolveTurnTokens(200_000, { EIGHT_TURN_TOKENS: "0" })).toBe(0);
		expect(resolveTurnLimits(1000, {})).toEqual({ toolCap: 48, blocks: 3, tokens: 500 });
	});
});

describe("TurnGuard", () => {
	const limits = { toolCap: 5, blocks: 3, tokens: 0 };
	it("the cap line names the count, the tools and how to continue", () => {
		const g = new TurnGuard(limits);
		g.round({ calls: Array(5).fill({ name: "read_file" }) });
		const line = g.stop() as string;
		expect(line).toContain("Stopped after 5 tool calls (read_file)");
		expect(line).toContain('Say "continue"');
		expect(line).toContain("EIGHT_TURN_TOOL_CAP");
	});
	it("three refused calls in a row stop it, naming the commands and the reason", () => {
		const g = new TurnGuard(limits);
		g.round({
			calls: [
				{ name: "run_command", detail: "sudo one", blockedReason: "destructive" },
				{ name: "run_command", detail: "sudo two", blockedReason: "sudo is not allowed" },
			],
		});
		expect(g.stop()).toBeNull();
		g.round({
			calls: [{ name: "run_command", detail: "sudo three", blockedReason: "nope" }],
		});
		const line = g.stop() as string;
		expect(line).toContain("3 tool calls in a row were refused");
		expect(line).toContain("sudo one");
		expect(line).toContain("nope");
		expect(line).toContain("What would you like me to do instead?");
	});
	it("a call that ran between refusals resets the run", () => {
		const g = new TurnGuard({ toolCap: 0, blocks: 3, tokens: 0 });
		for (let i = 0; i < 4; i++) {
			g.round({
				calls: [
					{ name: "run_command", detail: `bad ${i}`, blockedReason: "no" },
					{ name: "run_command", detail: `bad b${i}`, blockedReason: "no" },
					{ name: "read_file", detail: `f${i}` },
				],
			});
		}
		expect(g.stop()).toBeNull();
	});
	it("the same command refused twice stops it", () => {
		const g = new TurnGuard(limits);
		g.round({ calls: [{ name: "run_command", detail: "sudo one", blockedReason: "no" }] });
		expect(g.stop()).toBeNull();
		g.round({ calls: [{ name: "run_command", detail: "sudo one", blockedReason: "no" }] });
		expect(g.stop()).toContain("refused");
	});
	it("tokens added this turn past the budget stop it with the count and Keep going?", () => {
		const g = new TurnGuard({ toolCap: 0, blocks: 0, tokens: 1000 });
		g.round({ calls: [{ name: "a" }], contextTokens: 5200, startTokens: 5000 });
		expect(g.stop()).toBeNull();
		g.round({ calls: [{ name: "a" }], contextTokens: 6300 });
		expect(g.stop()).toContain("1300 tokens");
		expect(g.stop()).toContain("Keep going?");
	});
	it("a refused command with a token is scrubbed in the line; a credential path names the tool only", async () => {
		const { scrub } = await import("../eight/secret-scanner");
		const withScrub = { ...limits, scrub: (t: string) => scrub(t).scrubbed };
		const g = new TurnGuard(withScrub);
		const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
		g.round({
			calls: [
				{
					name: "run_command",
					detail: `curl -H "Authorization: Bearer ${key}" https://x.test`,
					blockedReason: "network blocked",
				},
				{ name: "run_command", detail: "cat ~/.ssh/id_rsa", blockedReason: "reads a key" },
				{ name: "run_command", detail: "cat .env", blockedReason: "reads .env" },
			],
		});
		const line = g.stop() as string;
		expect(line).toContain("[REDACTED:");
		expect(line).not.toContain(key);
		expect(line).not.toContain("id_rsa");
		expect(line).not.toContain(".env");
		expect(line).toContain("it touched a protected path");
	});
	it("no input count on step 0 never trips the token budget (totalTokens-only provider)", () => {
		const limits2 = { toolCap: 0, blocks: 0, tokens: 1000 };
		expect(
			turnStopForSteps(
				[
					{ toolCalls: [{ toolName: "a" }], usage: { totalTokens: 5000 } },
					{ toolCalls: [{ toolName: "a" }], usage: { totalTokens: 9000 } },
				],
				limits2,
			),
		).toBeNull();
		expect(
			turnStopForSteps(
				[
					{ toolCalls: [{ toolName: "a" }], usage: { inputTokens: 5000, totalTokens: 5100 } },
					{ toolCalls: [{ toolName: "a" }], usage: { totalTokens: 9000 } },
				],
				limits2,
			),
		).toContain("Keep going?");
	});
	it("all limits at 0 never stop", () => {
		const g = new TurnGuard({ toolCap: 0, blocks: 0, tokens: 0 });
		g.round({ calls: Array(500).fill({ name: "a", blockedReason: "x" }), contextTokens: 9e9 });
		expect(g.stop()).toBeNull();
	});
	it("reads a gate prefix the way the text loop does", () => {
		expect(blockedReasonOf("[TOOLG8 BLOCKED] Reason: no sudo. Alternative: none")).toBe("no sudo");
		expect(blockedReasonOf("fine")).toBeNull();
		expect(blockedReasonOf("Error: ENOENT")).toBeNull();
		// #3409: chaining refusals and a printed marker are not counted.
		expect(
			blockedReasonOf("[BLOCKED] Command chaining with && is not allowed. Run each alone."),
		).toBeNull();
		expect(
			blockedReasonOf(
				"[BLOCKED] Command chaining with && is not allowed. Run each alone. Command: a && b",
			),
		).toBeNull();
		// The words inside the echoed command do not exempt a different refusal.
		expect(
			blockedReasonOf(
				"[BLOCKED] Substitution is not allowed. Command: echo $(id) # command chaining is not allowed",
			),
		).toBe("Substitution is not allowed");
		expect(blockedReasonOf("[BLOCKED] x 3")).toBeNull();
		expect(blockedReasonOf("[BLOCKED] Not here. Command: sudo x")).toBe("Not here");
	});
});

const CALL = (n: number, command = `echo ${n}`) =>
	["```tool_call", JSON.stringify({ name: "probe", arguments: { command } }), "```"].join("\n");

describe("text-tool loop in Infinite (carry-on, progress sink)", () => {
	function probeTool(result: () => string): TextTool {
		return {
			spec: { name: "probe", description: "p", parameters: { type: "object", properties: {} } },
			run: async () => result(),
		};
	}

	it("a model that never stops ends at the cap with the plain line", async () => {
		let calls = 0;
		const progress: string[] = [];
		const out = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [probeTool(() => "ok")],
			maxRounds: 500,
			silentCalls: 24,
			silentProgress: (l) => progress.push(l),
			turnLimits: { toolCap: 48, blocks: 3, tokens: 0 },
			call: async () => CALL(++calls),
		});
		expect(out.toolLog).toHaveLength(48);
		expect(calls).toBe(48);
		expect(out.content).toContain("Stopped after 48 tool calls (probe)");
		expect(progress.length).toBe(1);
	});

	it("without limits (headless) the loop is untouched", async () => {
		let calls = 0;
		const out = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [probeTool(() => "ok")],
			maxRounds: 60,
			call: async () => (++calls > 50 ? "DONE: fifty" : CALL(calls)),
		});
		expect(out.toolLog).toHaveLength(50);
	});

	it("the third blocked call ends the turn", async () => {
		let calls = 0;
		const out = await runTextToolAgent({
			messages: [{ role: "user", content: "go" }],
			tools: [probeTool(() => "[TOOLG8 BLOCKED] Reason: sudo is not allowed. Alternative: none")],
			maxRounds: 50,
			silentCalls: 24,
			silentProgress: () => {},
			turnLimits: { toolCap: 48, blocks: 3, tokens: 0 },
			call: async () => CALL(++calls, `sudo thing ${calls}`),
		});
		expect(calls).toBe(3);
		expect(out.content).toContain("3 tool calls in a row were refused");
		expect(out.content).toContain("sudo thing 1");
		expect(out.content).toContain("sudo is not allowed");
	});
});

describe("native loop in Infinite (carry-on, progress sink)", () => {
	const usageOf = (input: number, output: number) =>
		({
			inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: output, text: output, reasoning: 0 },
		}) as any;

	function build(opts: {
		limits: { toolCap: number; blocks: number; tokens: number };
		input?: (n: number) => number;
		gate?: (name: string, args: any) => string | null;
	}) {
		let n = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async () => {
				n++;
				return {
					content: [
						{
							type: "tool-call",
							toolCallId: `c${n}`,
							toolName: "probe",
							input: JSON.stringify({ command: `cmd ${n}` }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage: usageOf(opts.input?.(n) ?? 10, 5),
					warnings: [],
				} as any;
			},
		});
		let tools: any = {
			probe: tool({
				description: "p",
				inputSchema: z.object({}).passthrough(),
				execute: async () => "ok",
			}),
		};
		if (opts.gate) {
			const gate = opts.gate;
			tools = gateTools(tools, async ({ toolName, args }) => gate(toolName, args));
		}
		const turnStop = { line: null as string | null };
		const progress: string[] = [];
		const agent = createEightAgent({
			provider: { name: "minimax", model: "mock" } as any,
			model: model as any,
			tools,
			maxSteps: 500,
			turnBudgetMs: 0,
			silentCalls: 24,
			silentProgress: (l) => progress.push(l),
			turnLimits: opts.limits,
			turnStop,
		});
		return { agent, turnStop, progress, calls: () => n };
	}

	it("(a) the cap ends the turn with the plain line, Infinite progress lines kept", async () => {
		const { agent, turnStop, progress, calls } = build({
			limits: { toolCap: 48, blocks: 3, tokens: 0 },
		});
		await agent.generate({ prompt: "I just wanted to hear the voice TTS" });
		expect(calls()).toBe(48);
		expect(turnStop.line).toContain("Stopped after 48 tool calls (probe)");
		expect(progress.length).toBe(1);
	});

	it("(b) the third refused call ends the turn", async () => {
		const { agent, turnStop, calls } = build({
			limits: { toolCap: 48, blocks: 3, tokens: 0 },
			gate: () => "not allowed here",
		});
		await agent.generate({ prompt: "go" });
		expect(calls()).toBe(3);
		expect(turnStop.line).toContain("3 tool calls in a row were refused");
		expect(turnStop.line).toContain("cmd 1");
		expect(turnStop.line).toContain("not allowed here");
	});

	it("(c) the token budget ends the turn", async () => {
		const { agent, turnStop, calls } = build({
			limits: { toolCap: 0, blocks: 0, tokens: 1000 },
			input: (n) => 100 + n * 300,
		});
		await agent.generate({ prompt: "go" });
		expect(calls()).toBeLessThan(10);
		expect(turnStop.line).toContain("Keep going?");
		expect(turnStop.line).toContain("limit 1000");
	});

	it("each generate starts a fresh budget", async () => {
		const { agent, turnStop } = build({ limits: { toolCap: 3, blocks: 0, tokens: 0 } });
		await agent.generate({ prompt: "go" });
		expect(turnStop.line).toContain("Stopped after 3 tool calls");
		await agent.generate({ prompt: "continue" });
		expect(turnStop.line).toContain("Stopped after 3 tool calls");
	});
});
