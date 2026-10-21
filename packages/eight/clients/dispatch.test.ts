/**
 * Dispatcher parity (SPEC-05 #108): the role/createClient path must route
 * `anthropic` to a real Anthropic client, not fold it onto the OpenRouter
 * runtime. Mirrors the correct Anthropic branch in `ProviderManager.chat`.
 */

import { describe, expect, test } from "bun:test";
import { AnthropicClient, OpenRouterClient, createClient, runtimeForProvider } from "./index";

describe("runtimeForProvider", () => {
	test("anthropic maps to its own runtime, not openrouter", () => {
		expect(runtimeForProvider("anthropic")).toBe("anthropic");
	});

	test("other OpenAI-compatible cloud providers still fold onto openrouter", () => {
		expect(runtimeForProvider("groq")).toBe("openrouter");
		expect(runtimeForProvider("mistral")).toBe("openrouter");
		expect(runtimeForProvider("openrouter")).toBe("openrouter");
	});

	test("8gent GGUF runs on the local ollama runtime", () => {
		expect(runtimeForProvider("8gent")).toBe("ollama");
		expect(runtimeForProvider("ollama")).toBe("ollama");
	});
});

describe("createClient dispatch parity", () => {
	test("anthropic runtime builds an AnthropicClient, not an OpenRouterClient", () => {
		const client = createClient({
			runtime: "anthropic",
			model: "claude-3-5-sonnet-latest",
			apiKey: "sk-ant-test",
		});
		expect(client).toBeInstanceOf(AnthropicClient);
		expect(client).not.toBeInstanceOf(OpenRouterClient);
	});

	test("openrouter runtime still builds an OpenRouterClient", () => {
		const client = createClient({
			runtime: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
			apiKey: "sk-or-test",
		});
		expect(client).toBeInstanceOf(OpenRouterClient);
		expect(client).not.toBeInstanceOf(AnthropicClient);
	});
});

describe("a hosted registry runtime (#4682)", () => {
	test("minimax builds the OpenAI-compatible client, not an Ollama one", () => {
		const client = createClient({ runtime: "minimax" as never, model: "m", apiKey: "k" });
		expect(client).toBeInstanceOf(OpenRouterClient);
	});

	test("its readiness asks the provider's own endpoint with its key", async () => {
		const seen: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				seen.push(`${new URL(req.url).pathname} ${req.headers.get("authorization")}`);
				return Response.json({ data: [{ id: "m" }] });
			},
		});
		try {
			const client = createClient({
				runtime: "minimax" as never,
				model: "m",
				apiKey: "placeholder-not-a-key",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
			});
			expect(await client.readiness?.()).toEqual({ ok: true });
			expect(seen).toEqual(["/v1/models Bearer placeholder-not-a-key"]);
		} finally {
			server.stop(true);
		}
	});
});
