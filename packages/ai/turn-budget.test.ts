import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createEightAgent } from "./agent";
import { DEFAULT_TURN_BUDGET_MS, createBudgetDrain, resolveTurnBudgetMs } from "./turn-budget";

describe("resolveTurnBudgetMs", () => {
	it("defaults, honours env, allows 0, rejects junk", () => {
		expect(resolveTurnBudgetMs({})).toBe(DEFAULT_TURN_BUDGET_MS);
		expect(resolveTurnBudgetMs({ EIGHT_TURN_BUDGET_MS: "5000" })).toBe(5000);
		expect(resolveTurnBudgetMs({ EIGHT_TURN_BUDGET_MS: "0" })).toBe(0);
		expect(resolveTurnBudgetMs({ EIGHT_TURN_BUDGET_MS: "abc" })).toBe(DEFAULT_TURN_BUDGET_MS);
	});
});

describe("createBudgetDrain", () => {
	it("is silent before 80%, fires once after, never when disabled", async () => {
		let t = 0;
		const step = createBudgetDrain({ budgetMs: 1000, now: () => t });
		expect(step()).toEqual([]);
		t = 100;
		expect(step()).toEqual([]);
		for (t = 200; t <= 700; t += 100) expect(step()).toEqual([]);
		t = 850;
		const out = step();
		expect(out.length).toBe(1);
		expect(out[0]).toContain("TIME BUDGET");
		t = 990;
		expect(step()).toEqual([]);
		const off = createBudgetDrain({ budgetMs: 0, now: () => t });
		t = 99999;
		expect(off()).toEqual([]);
	});

	it("fires early when the slowest step would not fit in the remaining time", async () => {
		let t = 0;
		const step = createBudgetDrain({ budgetMs: 1000, now: () => t });
		step();
		t = 400; // one 400 ms step, 40% elapsed: another would still fit
		expect(step()).toEqual([]);
		t = 600; // 60% elapsed, below the 80% line, but 600 + 400 >= 95%
		expect(step().length).toBe(1);
	});
});

describe("long task writes a best-effort file before the budget runs out", () => {
	it("real agent loop: nudge makes the model write the output path", async () => {
		const out = join(mkdtempSync(join(tmpdir(), "budget-")), "answer.json");
		const seenNudge = (prompt: any[]) => JSON.stringify(prompt).includes("TIME BUDGET");
		let calls = 0;
		const model = new MockLanguageModelV3({
			doGenerate: async ({ prompt }: any) => {
				calls++;
				const finishReason = { unified: "tool-calls", raw: undefined } as any;
				const usage = {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				} as any;
				if (JSON.stringify(prompt).includes('"write_file"') && existsSync(out)) {
					return {
						content: [{ type: "text", text: "done" }],
						finishReason: { unified: "stop", raw: undefined },
						usage,
						warnings: [],
					} as any;
				}
				const call = seenNudge(prompt)
					? { toolName: "write_file", input: JSON.stringify({ path: out, content: "[[0]]" }) }
					: { toolName: "think", input: "{}" };
				return {
					content: [{ type: "tool-call", toolCallId: `c${calls}`, ...call }],
					finishReason,
					usage,
					warnings: [],
				} as any;
			},
		});
		const tools = {
			think: tool({
				description: "slow reasoning step",
				inputSchema: z.object({}),
				execute: async () => {
					await new Promise((r) => setTimeout(r, 120));
					return "thought";
				},
			}),
			write_file: tool({
				description: "write a file",
				inputSchema: z.object({ path: z.string(), content: z.string() }),
				execute: async ({ path, content }) => {
					await Bun.write(path, content);
					return "written";
				},
			}),
		} as any;
		const agent = createEightAgent({
			provider: { name: "ollama", model: "mock" } as any,
			model: model as any,
			tools,
			maxSteps: 50,
			turnBudgetMs: 600, // 80% = 480 ms, ~4 slow steps
		});
		const started = Date.now();
		await agent.generate({ prompt: "Solve the puzzle and write answer.json" });
		expect(existsSync(out)).toBe(true);
		expect(readFileSync(out, "utf8")).toBe("[[0]]");
		expect(Date.now() - started).toBeLessThan(600);
	});

	it("without the nudge (budget 0) the same loop never writes", async () => {
		const out = join(mkdtempSync(join(tmpdir(), "budget-")), "answer.json");
		const model = new MockLanguageModelV3({
			doGenerate: async ({ prompt }: any) =>
				({
					content: [
						{
							type: "tool-call",
							toolCallId: `c${Math.random()}`,
							toolName: JSON.stringify(prompt).includes("TIME BUDGET") ? "write_file" : "think",
							input: JSON.stringify({ path: out, content: "x" }),
						},
					],
					finishReason: { unified: "tool-calls", raw: undefined },
					usage: {
						inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 1, text: 1, reasoning: 0 },
					},
					warnings: [],
				}) as any,
		});
		const tools = {
			think: tool({
				description: "t",
				inputSchema: z.object({}).passthrough(),
				execute: async () => "ok",
			}),
			write_file: tool({
				description: "w",
				inputSchema: z.object({}).passthrough(),
				execute: async () => "ok",
			}),
		} as any;
		const agent = createEightAgent({
			provider: { name: "ollama", model: "mock" } as any,
			model: model as any,
			tools,
			maxSteps: 5,
			turnBudgetMs: 0,
		});
		await agent.generate({ prompt: "go" });
		expect(existsSync(out)).toBe(false);
	});
});
