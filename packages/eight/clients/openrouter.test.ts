import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterClient } from "./openrouter.js";

/**
 * OpenRouter's /models is public: it answers 200 with no key or a bad one,
 * so it said "ready" under a NO MODEL card asking for a key (#3290). On
 * openrouter.ai the readiness check is the authenticated /key instead.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(status: number) {
	const calls: Array<{ url: string; auth: string | null }> = [];
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({ url: String(url), auth: headers.get("Authorization") });
		return new Response("{}", { status });
	}) as typeof fetch;
	return calls;
}

describe("OpenRouterClient.isAvailable", () => {
	test("no key on openrouter.ai: not ready, and no request is made", async () => {
		const calls = stubFetch(200);
		expect(await new OpenRouterClient("auto", "").isAvailable()).toBe(false);
		expect(calls.length).toBe(0);
	});

	test("openrouter.ai checks the authenticated /key, never the public /models", async () => {
		const calls = stubFetch(200);
		expect(await new OpenRouterClient("auto", "sk-or-test").isAvailable()).toBe(true);
		expect(calls).toEqual([{ url: "https://openrouter.ai/api/v1/key", auth: "Bearer sk-or-test" }]);
	});

	test("a key openrouter.ai refuses is not ready", async () => {
		stubFetch(401);
		expect(await new OpenRouterClient("auto", "sk-or-bad").isAvailable()).toBe(false);
	});

	test("other OpenAI-style hosts keep /models", async () => {
		const calls = stubFetch(200);
		expect(await new OpenRouterClient("m", "k", "https://api.groq.com/openai/v1").isAvailable()).toBe(true);
		expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/models");
	});
});
