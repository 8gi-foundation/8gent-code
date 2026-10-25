/**
 * The refusal gate runs inside execute, where a refusal stops the call. A
 * throw from experimental_onToolCallStart does not: the SDK swallows it.
 */
import { describe, expect, test } from "bun:test";
import { ToolLoopAgent, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { gateTools } from "./agent";

const usage = {
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function oneCallModel(prompts: unknown[][]) {
	let n = 0;
	return new MockLanguageModelV3({
		doGenerate: async (opts) => {
			prompts.push(opts.prompt as unknown[]);
			if (++n === 1) {
				return {
					content: [
						{ type: "tool-call" as const, toolCallId: "c1", toolName: "write", input: "{}" },
					],
					finishReason: { unified: "tool-calls" as const, raw: undefined },
					usage,
					warnings: [],
				};
			}
			return {
				content: [{ type: "text" as const, text: "ok" }],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage,
				warnings: [],
			};
		},
	});
}

function counting() {
	const state = { ran: 0 };
	const tools = {
		write: tool({
			inputSchema: jsonSchema({ type: "object", properties: {} }),
			execute: async () => {
				state.ran++;
				return "written";
			},
		}),
	};
	return { state, tools };
}

describe("gateTools", () => {
	test("a throw in onToolCallStart does not stop the tool (why the gate exists)", async () => {
		const { state, tools } = counting();
		await new ToolLoopAgent({
			model: oneCallModel([]),
			tools,
			stopWhen: stepCountIs(3),
			experimental_onToolCallStart: () => {
				throw new Error("refused");
			},
		}).generate({ messages: [{ role: "user", content: "go" }] });
		expect(state.ran).toBe(1);
	});

	test("a refusal from the gate stops the tool and reaches the model", async () => {
		const { state, tools } = counting();
		const prompts: unknown[][] = [];
		const seen: string[] = [];
		await new ToolLoopAgent({
			model: oneCallModel(prompts),
			tools: gateTools(tools, (e) => {
				seen.push(e.toolName);
				return "refused by gate";
			}),
			stopWhen: stepCountIs(3),
		}).generate({ messages: [{ role: "user", content: "go" }] });
		expect(state.ran).toBe(0);
		expect(seen).toEqual(["write"]);
		expect(JSON.stringify(prompts[1])).toContain("refused by gate");
	});

	test("null lets the tool run; the input set is not changed", async () => {
		const { state, tools } = counting();
		const original = tools.write.execute;
		await new ToolLoopAgent({
			model: oneCallModel([]),
			tools: gateTools(tools, () => null),
			stopWhen: stepCountIs(3),
		}).generate({ messages: [{ role: "user", content: "go" }] });
		expect(state.ran).toBe(1);
		expect(tools.write.execute).toBe(original);
	});
});

describe("plug hooks on native tools (#5055)", () => {
	const make = () => {
		const seen: unknown[] = [];
		const tools = {
			read: tool({
				inputSchema: jsonSchema({ type: "object", properties: {} }),
				execute: async (input: unknown) => {
					seen.push(input);
					return "customer Jane Doe";
				},
			}),
		};
		return { seen, tools };
	};
	const run = (t: unknown, input: unknown) =>
		(t as { execute: (i: unknown, o: { toolCallId: string }) => Promise<unknown> }).execute(input, {
			toolCallId: "c1",
		});

	test("a gate that hands back args runs the tool with them", async () => {
		const { seen, tools } = make();
		const gated = gateTools(tools, () => ({ args: { path: "changed" } }));
		await run(gated.read, { path: "original" });
		expect(seen).toEqual([{ path: "changed" }]);
	});

	test("rewriteToolResult changes a string result; a throw keeps the original", async () => {
		const { tools } = make();
		const rewritten = gateTools(
			tools,
			() => null,
			(_e, r) => r.replace("Jane Doe", "[name removed]"),
		);
		expect(await run(rewritten.read, {})).toBe("customer [name removed]");
		const broken = gateTools(
			tools,
			() => null,
			() => {
				throw new Error("boom");
			},
		);
		expect(await run(broken.read, {})).toBe("customer Jane Doe");
	});
});
