/**
 * Smoke tests for the proxy wire mapping and routing shell.
 *
 * These exercise the pure OpenAI translation layer and the static routes
 * (health, models, error envelopes) without dispatching to a live model - the
 * model dispatch itself is the router's own tested surface in
 * `packages/providers`.
 */

import { describe, expect, test } from "bun:test";
import type { ChatResponse } from "../../../packages/providers";
import {
	toChatRequest,
	toOpenAICompletion,
	toOpenAISSE,
	toToolDefinitions,
} from "./openai";
import { handle } from "./server";

describe("openai request mapping", () => {
	test("maps messages, model, temperature and reasoning_effort", () => {
		const req = toChatRequest({
			model: "eight-1.0-q3:14b",
			messages: [
				{ role: "system", content: "be terse" },
				{ role: "user", content: "hi" },
			],
			temperature: 0.2,
			max_tokens: 128,
			reasoning_effort: "high",
		});
		expect(req.model).toBe("eight-1.0-q3:14b");
		expect(req.messages).toHaveLength(2);
		expect(req.messages[0].role).toBe("system");
		expect(req.temperature).toBe(0.2);
		expect(req.maxTokens).toBe(128);
		expect(req.thinking).toBe("high");
	});

	test("flattens array content parts to text", () => {
		const req = toChatRequest({
			messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }],
		});
		expect(req.messages[0].content).toBe("ab");
	});

	test("unknown roles fall back to user", () => {
		const req = toChatRequest({ messages: [{ role: "developer", content: "x" }] });
		expect(req.messages[0].role).toBe("user");
	});

	test("drops unsupported reasoning_effort values", () => {
		const req = toChatRequest({ messages: [{ role: "user", content: "x" }], reasoning_effort: "ultra" });
		expect(req.thinking).toBeUndefined();
	});

	test("passes through OpenAI tool definitions", () => {
		const tools = toToolDefinitions([
			{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object" } } },
		]);
		expect(tools).toHaveLength(1);
		expect(tools?.[0].function.name).toBe("get_weather");
	});
});

describe("openai response mapping", () => {
	const res: ChatResponse = {
		content: "hello",
		model: "eight-1.0-q3:14b",
		provider: "8gent",
		usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
	};

	test("non-streaming completion has an OpenAI shape", () => {
		const c = toOpenAICompletion(res);
		expect(c.object).toBe("chat.completion");
		expect(c.choices[0].message.content).toBe("hello");
		expect(c.choices[0].finish_reason).toBe("stop");
		expect(c.usage?.total_tokens).toBe(5);
	});

	test("tool calls serialize arguments as JSON strings", () => {
		const withTool: ChatResponse = {
			...res,
			toolCalls: [{ id: "call_0", name: "get_weather", arguments: { city: "Dublin" } }],
		};
		const c = toOpenAICompletion(withTool);
		expect(c.choices[0].finish_reason).toBe("tool_calls");
		const tc = c.choices[0].message.tool_calls?.[0];
		expect(tc?.function.name).toBe("get_weather");
		expect(JSON.parse(tc?.function.arguments ?? "{}").city).toBe("Dublin");
	});

	test("SSE stream terminates with [DONE]", () => {
		const sse = toOpenAISSE(res);
		expect(sse).toContain('"role":"assistant"');
		expect(sse).toContain('"content":"hello"');
		expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});
});

describe("http routing shell", () => {
	test("GET /health reports the active selection", async () => {
		const r = await handle(new Request("http://localhost/health"));
		expect(r.status).toBe(200);
		const body = (await r.json()) as { status: string; activeProvider: string };
		expect(body.status).toBe("ok");
		expect(typeof body.activeProvider).toBe("string");
	});

	test("GET /v1/models returns an OpenAI list", async () => {
		const r = await handle(new Request("http://localhost/v1/models"));
		expect(r.status).toBe(200);
		const body = (await r.json()) as { object: string; data: unknown[] };
		expect(body.object).toBe("list");
		expect(Array.isArray(body.data)).toBe(true);
	});

	test("unknown route returns a 404 error envelope", async () => {
		const r = await handle(new Request("http://localhost/nope"));
		expect(r.status).toBe(404);
		const body = (await r.json()) as { error: { type: string } };
		expect(body.error.type).toBe("not_found");
	});

	test("POST with invalid JSON is a 400", async () => {
		const r = await handle(
			new Request("http://localhost/v1/chat/completions", { method: "POST", body: "{" }),
		);
		expect(r.status).toBe(400);
	});

	test("POST with empty messages is a 400", async () => {
		const r = await handle(
			new Request("http://localhost/v1/chat/completions", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: [] }),
			}),
		);
		expect(r.status).toBe(400);
	});
});
