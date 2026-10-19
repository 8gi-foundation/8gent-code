/**
 * Per-model harness profile (#4439): defaults unchanged without an entry,
 * values clamped to bounds, one log line names the profile.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { DEFAULT_STREAM_IDLE_MS } from "../eight/turn-timeout";
import {
	HARNESS_BOUNDS,
	HARNESS_PROFILES,
	type HarnessProfileTable,
	REASONING_TEXT_RESERVE,
	applyReasoningCap,
	harnessProfileLine,
	resolveHarnessProfile,
} from "./harness-profile";
import { type ProviderName, createModel } from "./providers";
import { NUDGE_FRACTION, createBudgetDrain } from "./turn-budget";

const defaults = { maxSteps: 30, maxOutputTokens: 4096 };

describe("resolveHarnessProfile", () => {
	test("a model with no entry keeps today's defaults exactly", () => {
		const p = resolveHarnessProfile("some/unknown-model", defaults, {});
		expect(p).toEqual({
			source: "default",
			maxSteps: 30,
			nudgeFraction: NUDGE_FRACTION,
			maxOutputTokens: 4096,
		});
		expect(
			resolveHarnessProfile(undefined, { maxSteps: 30, maxOutputTokens: 8192 }, {}).maxOutputTokens,
		).toBe(8192);
	});

	test("an entry sets its values and names itself", () => {
		const table: HarnessProfileTable = {
			"m:1": { maxSteps: 50, nudgeFraction: 0.6, maxOutputTokens: 6000, why: "test" },
		};
		expect(resolveHarnessProfile("m:1", defaults, table)).toEqual({
			source: "m:1",
			maxSteps: 50,
			nudgeFraction: 0.6,
			maxOutputTokens: 6000,
		});
	});

	test("a field missing from an entry falls back to the default for that field", () => {
		const p = resolveHarnessProfile("m:1", defaults, { "m:1": { nudgeFraction: 0.7, why: "" } });
		expect(p.maxSteps).toBe(30);
		expect(p.maxOutputTokens).toBe(4096);
		expect(p.nudgeFraction).toBe(0.7);
	});

	test("values are clamped to bounds", () => {
		const low = resolveHarnessProfile("m", defaults, {
			m: { maxSteps: 3, nudgeFraction: 0.1, maxOutputTokens: 10, why: "" },
		});
		expect(low.maxSteps).toBe(20);
		expect(low.nudgeFraction).toBe(0.5);
		expect(low.maxOutputTokens).toBe(HARNESS_BOUNDS.maxOutputTokens[0]);
		const high = resolveHarnessProfile("m", defaults, {
			m: { maxSteps: 500, nudgeFraction: 1.5, maxOutputTokens: 10_000_000, why: "" },
		});
		expect(high.maxSteps).toBe(80);
		expect(high.nudgeFraction).toBe(0.9);
		expect(high.maxOutputTokens).toBe(HARNESS_BOUNDS.maxOutputTokens[1]);
	});

	test("a non-number value is ignored, not trusted", () => {
		const p = resolveHarnessProfile("m", defaults, {
			m: { maxSteps: "lots" as unknown as number, nudgeFraction: Number.NaN, why: "" },
		});
		expect(p.maxSteps).toBe(30);
		expect(p.nudgeFraction).toBe(NUDGE_FRACTION);
	});

	test("the shipped table is inside bounds and seeds local and cloud Qwen 3.8 27B", () => {
		for (const id of ["qwen3.8:27b-mlx", "qwen/qwen3.8-27b"]) {
			const entry = HARNESS_PROFILES[id];
			expect(entry).toBeDefined();
			expect(entry?.why.length).toBeGreaterThan(20);
			const p = resolveHarnessProfile(id, defaults);
			expect(p.source).toBe(id);
			expect(p).toEqual({
				source: id,
				...{
					maxSteps: entry?.maxSteps,
					nudgeFraction: entry?.nudgeFraction,
					maxOutputTokens: entry?.maxOutputTokens,
				},
			} as typeof p);
			expect(p.nudgeFraction).toBeLessThan(NUDGE_FRACTION);
		}
	});

	test("cloud MiniMax M3 gets room to finish reasoning, inside one native idle gap (#4450)", () => {
		const entry = HARNESS_PROFILES["minimax/minimax-m3"];
		expect(entry).toBeDefined();
		expect(entry?.why).toContain("length");
		const cloud = resolveHarnessProfile("minimax/minimax-m3", {
			maxSteps: 30,
			maxOutputTokens: 8192,
		});
		expect(cloud.source).toBe("minimax/minimax-m3");
		// Above the 8192 that every empty arc2-a step hit (finishReason length).
		expect(cloud.maxOutputTokens).toBeGreaterThan(8192);
		// The native path is generateText: one step sends no progress until it ends,
		// so at the slowest measured 100 tok/s it must finish inside the 300 s gap.
		expect((cloud.maxOutputTokens / 100) * 1000).toBeLessThan(DEFAULT_STREAM_IDLE_MS);
		// Only the output cap moves: steps and nudge stay at today's defaults.
		expect(cloud.maxSteps).toBe(30);
		expect(cloud.nudgeFraction).toBe(NUDGE_FRACTION);
	});
});

describe("harnessProfileLine", () => {
	test("one line naming the model, the profile and its values", () => {
		const line = harnessProfileLine("qwen3.8:27b-mlx", {
			source: "qwen3.8:27b-mlx",
			maxSteps: 50,
			nudgeFraction: 0.6,
			maxOutputTokens: 4096,
		});
		expect(line).toBe(
			"[harness-profile] model=qwen3.8:27b-mlx profile=qwen3.8:27b-mlx maxSteps=50 nudge=0.6 maxOutputTokens=4096",
		);
		expect(line.includes("\n")).toBe(false);
	});
});

describe("createBudgetDrain nudgeFraction", () => {
	test("fires at the given fraction instead of the fixed 0.8", () => {
		let t = 0;
		const drain = createBudgetDrain({ budgetMs: 10_000, now: () => t, nudgeFraction: 0.6 });
		for (let at = 100; at < 6000; at += 100) {
			t = at;
			expect(drain()).toEqual([]);
		}
		t = 6000;
		expect(drain()).toHaveLength(1);
	});

	test("without it the nudge point is unchanged", () => {
		let t = 0;
		const drain = createBudgetDrain({ budgetMs: 10_000, now: () => t });
		for (let at = 100; at < 8000; at += 100) {
			t = at;
			expect(drain()).toEqual([]);
		}
		t = 8000;
		expect(drain()).toHaveLength(1);
	});
});

describe("reasoning cap (#4454)", () => {
	const table: HarnessProfileTable = { "m:r": { reasoningMaxTokens: 8192, why: "test" } };

	test("openrouter with an entry gets reasoning.max_tokens", () => {
		const body = applyReasoningCap("openrouter", "m:r", { max_tokens: 16384 }, table);
		expect(body.reasoning).toEqual({ max_tokens: 8192 });
	});

	test("the field is clamped to leave room for text and tool calls", () => {
		const tight = applyReasoningCap("openrouter", "m:r", { max_tokens: 9000 }, table);
		expect(tight.reasoning).toEqual({ max_tokens: 9000 - REASONING_TEXT_RESERVE });
		expect(REASONING_TEXT_RESERVE).toBeGreaterThanOrEqual(2048);
		// No room at all: send nothing rather than a cap the model cannot use.
		const none = applyReasoningCap("openrouter", "m:r", { max_tokens: 2048 }, table);
		expect(none.reasoning).toBeUndefined();
		// No max_tokens on the request: the entry value, unclamped by it.
		expect(applyReasoningCap("openrouter", "m:r", {}, table).reasoning).toEqual({
			max_tokens: 8192,
		});
		const junk = applyReasoningCap(
			"openrouter",
			"m:j",
			{ max_tokens: 16384 },
			{
				"m:j": { reasoningMaxTokens: Number.NaN, why: "" },
			},
		);
		expect(junk.reasoning).toBeUndefined();
	});

	test("no entry or no field sends nothing new; other providers are untouched", () => {
		const body = { max_tokens: 16384, messages: [] };
		expect(applyReasoningCap("openrouter", "other/model", { ...body }, table)).toEqual(body);
		expect(
			applyReasoningCap(
				"openrouter",
				"m:x",
				{ ...body },
				{ "m:x": { maxOutputTokens: 4096, why: "" } },
			),
		).toEqual(body);
		for (const name of ["ollama", "lmstudio", "apfel", "llama-server"]) {
			expect(applyReasoningCap(name, "m:r", { ...body }, table)).toEqual(body);
		}
	});

	test("the shipped MiniMax M3 entry caps reasoning at 8192 inside its 16384 output cap", () => {
		const entry = HARNESS_PROFILES["minimax/minimax-m3"];
		expect(entry?.reasoningMaxTokens).toBe(8192);
		const body = applyReasoningCap("openrouter", "minimax/minimax-m3", {
			max_tokens: entry?.maxOutputTokens,
		});
		expect(body.reasoning).toEqual({ max_tokens: 8192 });
	});

	describe("the request createModel sends", () => {
		const realFetch = globalThis.fetch;
		afterEach(() => {
			globalThis.fetch = realFetch;
		});
		async function sentBody(name: ProviderName, model: string): Promise<Record<string, unknown>> {
			let sent: Record<string, unknown> = {};
			globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
				sent = JSON.parse(String(init?.body ?? "{}"));
				return new Response(
					JSON.stringify({
						id: "x",
						created: 0,
						model,
						choices: [
							{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
						],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}) as typeof fetch;
			await generateText({
				model: createModel({ name, model, apiKey: "test", baseURL: "https://example.invalid/v1" }),
				prompt: "hi",
				maxOutputTokens: 16384,
			});
			return sent;
		}

		test("openrouter MiniMax M3 carries reasoning.max_tokens", async () => {
			const body = await sentBody("openrouter", "minimax/minimax-m3");
			expect(body.max_tokens).toBe(16384);
			expect(body.reasoning).toEqual({ max_tokens: 8192 });
		});

		test("a model without the field and a non-openrouter provider send no reasoning", async () => {
			expect((await sentBody("openrouter", "qwen/qwen3.8-27b")).reasoning).toBeUndefined();
			expect((await sentBody("lmstudio", "minimax/minimax-m3")).reasoning).toBeUndefined();
		});
	});
});
