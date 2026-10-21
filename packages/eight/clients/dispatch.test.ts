/**
 * Dispatcher parity (SPEC-05 #108): the role/createClient path must route
 * `anthropic` to a real Anthropic client, not fold it onto the OpenRouter
 * runtime. Mirrors the correct Anthropic branch in `ProviderManager.chat`.
 */

import { describe, expect, test } from "bun:test";
import { getProviderManager } from "../../providers";
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

	function serve(seen: string[]) {
		return Bun.serve({
			port: 0,
			fetch(req) {
				seen.push(`${new URL(req.url).pathname} ${req.headers.get("authorization")}`);
				return Response.json({ data: [{ id: "m" }] });
			},
		});
	}
	// Point the manager's minimax entry at a local server, and optionally hold its key back.
	function withRegistry(baseUrl: string, withheld?: string) {
		const pm = getProviderManager();
		const get = pm.getProvider.bind(pm);
		const reason = pm.keyWithheldReason.bind(pm);
		pm.getProvider = ((n: never) => (n === "minimax" ? { ...get(n), baseUrl } : get(n))) as never;
		pm.keyWithheldReason = ((n: never) => (n === "minimax" ? withheld : reason(n))) as never;
		return () => {
			pm.getProvider = get as never;
			pm.keyWithheldReason = reason as never;
		};
	}

	test("its readiness asks the provider's registry endpoint with its key", async () => {
		const seen: string[] = [];
		const server = serve(seen);
		const restore = withRegistry(`http://127.0.0.1:${server.port}/v1`);
		try {
			const client = createClient({
				runtime: "minimax" as never,
				model: "m",
				apiKey: "placeholder-not-a-key",
			});
			expect(await client.readiness?.()).toEqual({ ok: true });
			expect(seen).toEqual(["/v1/models Bearer placeholder-not-a-key"]);
		} finally {
			restore();
			server.stop(true);
		}
	});

	test("a caller's baseUrl is ignored: the key goes only to the registry endpoint", async () => {
		const registry: string[] = [];
		const caller: string[] = [];
		const good = serve(registry);
		const other = serve(caller);
		const restore = withRegistry(`http://127.0.0.1:${good.port}/v1`);
		try {
			const client = createClient({
				runtime: "minimax" as never,
				model: "m",
				apiKey: "placeholder-not-a-key",
				baseUrl: `http://127.0.0.1:${other.port}/v1`,
			});
			await client.readiness?.();
			expect(caller).toEqual([]);
			expect(registry).toEqual(["/v1/models Bearer placeholder-not-a-key"]);
		} finally {
			restore();
			good.stop(true);
			other.stop(true);
		}
	});

	test("no key is sent while the manager holds that provider's key back", async () => {
		const seen: string[] = [];
		const server = serve(seen);
		const restore = withRegistry(`http://127.0.0.1:${server.port}/v1`, "not its default endpoint");
		try {
			const client = createClient({
				runtime: "minimax" as never,
				model: "m",
				apiKey: "placeholder-not-a-key",
			});
			await client.readiness?.();
			expect(seen.join("\n")).not.toContain("placeholder-not-a-key");
		} finally {
			restore();
			server.stop(true);
		}
	});
});
