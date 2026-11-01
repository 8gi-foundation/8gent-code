import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { buildTextToolCall } from "../ai/text-tool-endpoint";
import { ProviderManager } from "./index";
import {
	ANTHROPIC_THINKING_BUDGET,
	isThinkingUnsupported,
	thinkingRequestFields,
	thinkingWireFor,
} from "./thinking-request";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("thinkingRequestFields", () => {
	const ollamaNative = { provider: "ollama", model: "qwen3:14b", shape: "native" as const };
	const ollamaOpenai = { provider: "ollama", model: "qwen3:14b", shape: "openai" as const };

	it("sends nothing for off, on every provider", () => {
		for (const t of [
			ollamaNative,
			ollamaOpenai,
			{ provider: "openai", model: "o3", shape: "openai" as const },
		]) {
			expect(thinkingRequestFields(t, "off")).toEqual({
				applied: false,
				fields: {},
				reason: "off",
			});
		}
	});

	it("Ollama native: think false for low, true for medium and high", () => {
		expect(thinkingRequestFields(ollamaNative, "low").fields).toEqual({ think: false });
		expect(thinkingRequestFields(ollamaNative, "medium").fields).toEqual({ think: true });
		expect(thinkingRequestFields(ollamaNative, "high").fields).toEqual({ think: true });
	});

	it("Ollama native gpt-oss takes the level, since it cannot turn thinking off", () => {
		const t = { provider: "ollama", model: "gpt-oss:20b", shape: "native" as const };
		expect(thinkingRequestFields(t, "low").fields).toEqual({ think: "low" });
		expect(thinkingRequestFields(t, "high").fields).toEqual({ think: "high" });
	});

	it("Ollama /v1: reasoning_effort none for low, the level above it", () => {
		expect(thinkingRequestFields(ollamaOpenai, "low").fields).toEqual({ reasoning_effort: "none" });
		expect(thinkingRequestFields(ollamaOpenai, "medium").fields).toEqual({
			reasoning_effort: "medium",
		});
		expect(thinkingRequestFields(ollamaOpenai, "high").fields).toEqual({
			reasoning_effort: "high",
		});
	});

	it("max goes out as the highest real control: high, think true, the largest budget", () => {
		expect(thinkingRequestFields(ollamaNative, "max").fields).toEqual({ think: true });
		expect(thinkingRequestFields(ollamaOpenai, "max").fields).toEqual({ reasoning_effort: "high" });
		expect(
			thinkingRequestFields(
				{ provider: "gpt", model: "x", shape: "openai", baseUrl: "https://openrouter.ai/api/v1" },
				"max",
			).fields,
		).toEqual({ reasoning: { effort: "high" } });
		expect(
			thinkingRequestFields({ provider: "openai", model: "o3", shape: "openai" }, "max").fields,
		).toEqual({
			reasoning_effort: "high",
		});
		expect(
			thinkingRequestFields({ provider: "anthropic", model: "c", shape: "native" }, "max").fields,
		).toEqual({
			thinking: { type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGET.high },
		});
		expect(
			thinkingRequestFields({ provider: "lmstudio", model: "m", shape: "openai" }, "max").applied,
		).toBe(false);
	});

	it("OpenAI-compatible: reasoning_effort at each level", () => {
		const t = { provider: "openai", model: "o3", shape: "openai" as const };
		for (const level of ["low", "medium", "high"] as const) {
			expect(thinkingRequestFields(t, level).fields).toEqual({ reasoning_effort: level });
		}
	});

	it("OpenRouter, by name or by host: reasoning.effort", () => {
		const byName = { provider: "openrouter", model: "x/y", shape: "openai" as const };
		const byHost = {
			provider: "custom",
			model: "x/y",
			shape: "openai" as const,
			baseUrl: "https://openrouter.ai/api/v1",
		};
		for (const t of [byName, byHost]) {
			expect(thinkingRequestFields(t, "medium").fields).toEqual({
				reasoning: { effort: "medium" },
			});
		}
	});

	it("Anthropic: an extended-thinking budget per level", () => {
		const t = { provider: "anthropic", model: "claude", shape: "native" as const };
		expect(thinkingRequestFields(t, "high").fields).toEqual({
			thinking: { type: "enabled", budget_tokens: ANTHROPIC_THINKING_BUDGET.high },
		});
	});

	it("says not applicable where the provider has no control", () => {
		for (const provider of ["lmstudio", "llama-server", "apfel", "groq", "deepseek"]) {
			const r = thinkingRequestFields({ provider, model: "m", shape: "openai" }, "high");
			expect(r).toEqual({ applied: false, fields: {}, reason: "not-applicable" });
		}
		expect(thinkingWireFor({ provider: "anthropic", model: "m", shape: "openai" })).toBeNull();
	});

	it("reads a refusal about thinking, and nothing else", () => {
		expect(isThinkingUnsupported(400, '{"error":"\\"m\\" does not support thinking"}')).toBe(true);
		expect(isThinkingUnsupported(400, "bad json")).toBe(false);
		expect(isThinkingUnsupported(500, "thinking")).toBe(false);
	});
});

/** Stub fetch; resolve with every JSON body sent. */
function captureBodies(
	reply: (n: number, body: Record<string, unknown>) => Response = () =>
		Response.json({ choices: [{ message: { content: "ok" } }] }),
): Record<string, unknown>[] {
	const bodies: Record<string, unknown>[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		bodies.push(body);
		return reply(bodies.length, body);
	}) as unknown as typeof fetch;
	return bodies;
}

describe("the turn request carries the level", () => {
	const ask = [{ role: "user" as const, content: "hi" }];

	it("Ollama (/v1): the field at each level, nothing for off", async () => {
		const bodies = captureBodies();
		for (const thinking of ["off", "low", "medium", "high"] as const) {
			await buildTextToolCall({ provider: "ollama", model: "qwen3:14b", idleMs: null, thinking })(
				ask,
			);
		}
		expect(bodies[0]).not.toHaveProperty("reasoning_effort");
		expect(bodies[1].reasoning_effort).toBe("none");
		expect(bodies[2].reasoning_effort).toBe("medium");
		expect(bodies[3].reasoning_effort).toBe("high");
	});

	it("an OpenAI-compatible client: reasoning_effort at each level, nothing for off", async () => {
		const bodies = captureBodies();
		for (const thinking of ["off", "low", "medium", "high"] as const) {
			await buildTextToolCall({
				provider: "openai",
				model: "o3",
				baseUrl: "https://api.openai.com/v1",
				idleMs: null,
				thinking,
			})(ask);
		}
		expect(bodies[0]).not.toHaveProperty("reasoning_effort");
		expect(bodies.slice(1).map((b) => b.reasoning_effort)).toEqual(["low", "medium", "high"]);
	});

	it("LM Studio has no control: nothing is sent, and the call says so", async () => {
		const bodies = captureBodies();
		const applied: boolean[] = [];
		await buildTextToolCall({
			provider: "lmstudio",
			model: "m",
			idleMs: null,
			thinking: "high",
			onThinkingApplied: (a) => applied.push(a),
		})(ask);
		expect(bodies[0]).not.toHaveProperty("reasoning_effort");
		expect(applied).toEqual([false]);
	});

	it("a model that refuses the field gets the request again without it", async () => {
		const bodies = captureBodies((n) =>
			n === 1
				? new Response('{"error":"\\"m\\" does not support thinking"}', { status: 400 })
				: Response.json({ choices: [{ message: { content: "ok" } }] }),
		);
		const applied: boolean[] = [];
		const out = await buildTextToolCall({
			provider: "ollama",
			model: "m",
			idleMs: null,
			thinking: "high",
			onThinkingApplied: (a) => applied.push(a),
		})(ask);
		expect(out).toBe("ok");
		expect(bodies.length).toBe(2);
		expect(bodies[0].reasoning_effort).toBe("high");
		expect(bodies[1]).not.toHaveProperty("reasoning_effort");
		expect(applied).toEqual([true, false]);
	});
});

describe("ProviderManager sends the level", () => {
	const settings = () =>
		path.join(os.tmpdir(), `thinking-request-${Date.now()}-${Math.random()}.json`);

	it("Ollama /api/chat gets think, and nothing without a level", async () => {
		const bodies: Record<string, unknown>[] = [];
		globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({ message: { role: "assistant", content: "ok" }, model: "m" });
		}) as unknown as typeof fetch;
		const manager = new ProviderManager(settings());
		manager.setActiveProvider("ollama");
		const messages = [{ role: "user" as const, content: "hi" }];
		await manager.chat({ messages, model: "qwen3:14b" });
		await manager.chat({ messages, model: "qwen3:14b", thinking: "low" });
		await manager.chat({ messages, model: "qwen3:14b", thinking: "high" });
		expect(bodies[0]).not.toHaveProperty("think");
		expect(bodies[1].think).toBe(false);
		expect(bodies[2].think).toBe(true);
	});
});
