/**
 * Regression tests for #2805: the text-tool endpoint call must surface REAL
 * token usage when the local OpenAI-compatible endpoint reports it, and must
 * never fabricate usage when the endpoint omits it. This is the signal
 * packages/eight/agent.ts forwards to AgentEventCallbacks.onStepFinish so
 * StatusEvent.tokens is populated for the default local runtime.
 *
 * The endpoint is faked by stubbing fetch (the suite sandbox cannot bind
 * sockets); the full request-build + response-parse path in buildTextToolCall
 * still runs for real.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { TurnTimeoutError } from "../eight/turn-timeout";
import { buildTextToolCall, extractUsage, type TextToolUsage } from "./text-tool-endpoint";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubEndpoint(body: Record<string, unknown>): void {
	globalThis.fetch = (async () => Response.json(body)) as unknown as typeof fetch;
}

describe("buildTextToolCall onUsage (#2805)", () => {
	it("reports real usage from the endpoint response", async () => {
		stubEndpoint({
			choices: [{ message: { content: "TWO" } }],
			usage: { prompt_tokens: 41, completion_tokens: 7, total_tokens: 48 },
		});
		const seen: TextToolUsage[] = [];
		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			onUsage: (u) => seen.push(u),
		});
		const content = await call([{ role: "user", content: "hi" }]);

		expect(content).toBe("TWO");
		expect(seen.length).toBe(1);
		expect(seen[0]).toEqual({ promptTokens: 41, completionTokens: 7, totalTokens: 48 });
	});

	it("never fabricates usage when the endpoint omits it", async () => {
		stubEndpoint({ choices: [{ message: { content: "no usage here" } }] });
		const seen: TextToolUsage[] = [];
		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			onUsage: (u) => seen.push(u),
		});
		const content = await call([{ role: "user", content: "hi" }]);

		expect(content).toBe("no usage here");
		expect(seen.length).toBe(0);
	});

	it("ignores malformed usage (non-numeric fields) instead of inventing numbers", async () => {
		stubEndpoint({
			choices: [{ message: { content: "x" } }],
			usage: { prompt_tokens: "many", completion_tokens: null, total_tokens: "lots" },
		});
		const seen: TextToolUsage[] = [];
		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			onUsage: (u) => seen.push(u),
		});
		await call([{ role: "user", content: "hi" }]);
		expect(seen.length).toBe(0);
	});

	it("derives totalTokens from prompt+completion when total is absent but parts are real", async () => {
		stubEndpoint({
			choices: [{ message: { content: "x" } }],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		});
		const seen: TextToolUsage[] = [];
		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			onUsage: (u) => seen.push(u),
		});
		await call([{ role: "user", content: "hi" }]);
		expect(seen.length).toBe(1);
		expect(seen[0]).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
	});
});

describe("extractUsage (#2805)", () => {
	it("returns null for missing or non-object usage", () => {
		expect(extractUsage(null)).toBeNull();
		expect(extractUsage({})).toBeNull();
		expect(extractUsage({ usage: "48 tokens" })).toBeNull();
	});

	it("returns real numbers verbatim when all fields are present", () => {
		expect(
			extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
		).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
	});

	it("rejects non-finite numbers", () => {
		expect(
			extractUsage({ usage: { prompt_tokens: Number.NaN, completion_tokens: 2 } }),
		).toBeNull();
	});
});

describe("buildTextToolCall model-step limit (hidden 300 s Bun timeout)", () => {
	it("sends timeout: false so Bun never kills a long model step on its own", async () => {
		let seen: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_input: unknown, init?: Record<string, unknown>) => {
			seen = init;
			return Response.json({ choices: [{ message: { content: "ok" } }] });
		}) as unknown as typeof fetch;
		const call = buildTextToolCall({ provider: "ollama", model: "m", timeoutMs: 5_000 });
		expect(await call([{ role: "user", content: "hi" }])).toBe("ok");
		expect(seen?.timeout).toBe(false);
	});

	it("honours an injected limit against a real slow local server", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			async fetch(req) {
				const delay = Number(new URL(req.url).searchParams.get("delay") ?? "0");
				await Bun.sleep(delay);
				return Response.json({ choices: [{ message: { content: `slept ${delay}` } }] });
			},
		});
		try {
			const endpoint = `http://127.0.0.1:${server.port}/v1/chat/completions`;
			const fast = buildTextToolCall({
				provider: "ollama",
				model: "m",
				endpoint: `${endpoint}?delay=300`,
				timeoutMs: 3_000,
			});
			expect(await fast([{ role: "user", content: "hi" }])).toBe("slept 300");

			const slow = buildTextToolCall({
				provider: "ollama",
				model: "m",
				endpoint: `${endpoint}?delay=2000`,
				timeoutMs: 150,
			});
			const err = await slow([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(TurnTimeoutError);
			expect((err as TurnTimeoutError).timeoutMs).toBe(150);
		} finally {
			server.stop(true);
		}
	});
});
