import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterClient, READY_CHECK_TIMEOUT_MS, readyFromStatus } from "./openrouter.js";

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

describe("OpenRouterClient.readiness: why not, bounded", () => {
	test("the check carries a timeout signal, so a host that never answers cannot hang init", async () => {
		let signal: AbortSignal | null | undefined;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			signal = init?.signal;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;
		await new OpenRouterClient("auto", "sk-or-test").readiness();
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(READY_CHECK_TIMEOUT_MS).toBe(3000);
	});

	test("no key: says so, with no request", async () => {
		const calls = stubFetch(200);
		expect(await new OpenRouterClient("auto", "").readiness()).toEqual({ ok: false, reason: "has no API key." });
		expect(calls.length).toBe(0);
	});

	test("a thrown fetch (refused, timed out) could not be reached", async () => {
		globalThis.fetch = (async () => {
			throw new Error("The operation timed out.");
		}) as unknown as typeof fetch;
		expect(await new OpenRouterClient("auto", "k").readiness()).toEqual({ ok: false, reason: "could not be reached." });
	});

	test("status codes: a refused key is not a busy host", () => {
		expect(readyFromStatus(200)).toEqual({ ok: true });
		expect(readyFromStatus(401)).toEqual({ ok: false, reason: "did not accept the API key." });
		expect(readyFromStatus(403)).toEqual({ ok: false, reason: "did not accept the API key." });
		expect(readyFromStatus(429)).toEqual({ ok: false, reason: "is busy (rate limited)." });
		expect(readyFromStatus(503)).toEqual({ ok: false, reason: "is busy (http 503)." });
		expect(readyFromStatus(404)).toEqual({ ok: false, reason: "answered with http 404." });
	});
});
