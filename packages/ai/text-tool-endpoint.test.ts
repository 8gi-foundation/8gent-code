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
import {
	buildTextToolCall,
	extractUsage,
	isNativeToolParserFailure,
	NATIVE_TOOL_MARKUP_REMINDER,
	type TextToolUsage,
} from "./text-tool-endpoint";

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

// The exact body Ollama 0.34.4 returned in Rishi's pilot (2026-09-29) when its
// built-in qwen3.5 parser choked on the model's native <tool_call> markup.
const OLLAMA_PARSER_EOF = JSON.stringify({
	error: { message: "EOF", type: "api_error", param: null, code: null },
});

type SeenRequest = { messages: Array<{ role: string; content: string }> };

// Serve a scripted sequence of responses, recording every request body.
function stubSequence(responses: Array<() => Response>): SeenRequest[] {
	const seen: SeenRequest[] = [];
	let i = 0;
	globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
		seen.push(JSON.parse(init?.body ?? "{}") as SeenRequest);
		const next = responses[Math.min(i, responses.length - 1)];
		i++;
		return next();
	}) as unknown as typeof fetch;
	return seen;
}

const parserEof = () => new Response(OLLAMA_PARSER_EOF, { status: 500 });
const ok = (content: string, usage?: Record<string, number>) => () =>
	Response.json({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });

describe("isNativeToolParserFailure (Ollama built-in parser 500)", () => {
	it("matches the pilot's 500 EOF body from ollama", () => {
		expect(isNativeToolParserFailure("ollama", 500, OLLAMA_PARSER_EOF)).toBe(true);
	});

	it("matches the other xml.Unmarshal failures the same parser can return", () => {
		const body = (message: string) => JSON.stringify({ error: { message } });
		expect(isNativeToolParserFailure("ollama", 500, body("unexpected EOF"))).toBe(true);
		expect(
			isNativeToolParserFailure(
				"ollama",
				500,
				body("XML syntax error on line 1: element <function> closed by </tool_call>"),
			),
		).toBe(true);
		// /api/chat shape: {"error":"EOF"}
		expect(isNativeToolParserFailure("ollama", 500, JSON.stringify({ error: "EOF" }))).toBe(true);
	});

	it("does not match unrelated 500s, other statuses, or other providers", () => {
		expect(
			isNativeToolParserFailure("ollama", 500, JSON.stringify({ error: { message: "boom" } })),
		).toBe(false);
		expect(isNativeToolParserFailure("ollama", 500, "not json")).toBe(false);
		expect(isNativeToolParserFailure("ollama", 400, OLLAMA_PARSER_EOF)).toBe(false);
		expect(isNativeToolParserFailure("lmstudio", 500, OLLAMA_PARSER_EOF)).toBe(false);
	});
});

describe("buildTextToolCall recovers from Ollama's native tool parser 500", () => {
	it("retries once with a format reminder and returns the retried reply", async () => {
		const seen = stubSequence([parserEof, ok("```tool_call\n{\"name\":\"run_command\"}\n```")]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		const original = [
			{ role: "system" as const, content: "sys" },
			{ role: "user" as const, content: "do it" },
		];
		const content = await call(original);

		expect(content).toContain("```tool_call");
		expect(seen.length).toBe(2);
		// First attempt is the untouched conversation.
		expect(seen[0].messages).toEqual(original);
		// The retry carries the same conversation plus one reminder turn.
		expect(seen[1].messages.slice(0, 2)).toEqual(original);
		expect(seen[1].messages.length).toBe(3);
		expect(seen[1].messages[2]).toEqual({ role: "user", content: NATIVE_TOOL_MARKUP_REMINDER });
		// The caller's array is never mutated.
		expect(original.length).toBe(2);
	});

	it("the reminder points at the fenced block and never names the native tag", () => {
		expect(NATIVE_TOOL_MARKUP_REMINDER).toContain("```tool_call");
		expect(NATIVE_TOOL_MARKUP_REMINDER).not.toContain("<tool_call>");
	});

	it("reports real usage from the successful retry only", async () => {
		stubSequence([parserEof, ok("done", { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 })]);
		const seen: TextToolUsage[] = [];
		const call = buildTextToolCall({ provider: "ollama", model: "m", onUsage: (u) => seen.push(u) });
		expect(await call([{ role: "user", content: "hi" }])).toBe("done");
		expect(seen).toEqual([{ promptTokens: 9, completionTokens: 2, totalTokens: 11 }]);
	});

	it("fails with a clear error after exactly one retry", async () => {
		const seen = stubSequence([parserEof, parserEof, ok("never reached")]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		const err = (await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e)) as Error;

		expect(seen.length).toBe(2);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toStartWith("ollama chat completions 500:");
		expect(err.message).toContain("built-in tool-call parser");
		expect(err.message).toContain("retried once");
		expect(err.message).toContain("EOF");
	});

	it("does not retry an unrelated 500", async () => {
		const seen = stubSequence([
			() => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }),
			ok("never reached"),
		]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		const err = (await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e)) as Error;
		expect(seen.length).toBe(1);
		expect(err.message).toBe('ollama chat completions 500: {"error":{"message":"boom"}}');
	});

	it("does not retry for other providers", async () => {
		const seen = stubSequence([parserEof, ok("never reached")]);
		const call = buildTextToolCall({ provider: "lmstudio", model: "m" });
		const err = (await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e)) as Error;
		expect(seen.length).toBe(1);
		expect(err.message).toStartWith("lmstudio chat completions 500:");
	});
});

describe("buildTextToolCall recovers a reply Ollama's parser silently swallowed", () => {
	// Live on qwen3.8:27b-mlx (2026-09-29): a reply with an unclosed native tag,
	// or one whose reasoning mentions it, comes back HTTP 200 with content ""
	// although the model generated tokens. The loop would take "" as the final
	// answer and end the turn with nothing.
	const swallowed = () =>
		Response.json({
			choices: [{ message: { content: "" } }],
			usage: { prompt_tokens: 50, completion_tokens: 113, total_tokens: 163 },
		});

	it("retries once with the reminder when ollama returns empty content for generated tokens", async () => {
		const seen = stubSequence([swallowed, ok("the deck has two files")]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		expect(await call([{ role: "user", content: "hi" }])).toBe("the deck has two files");
		expect(seen.length).toBe(2);
		expect(seen[1].messages.at(-1)).toEqual({ role: "user", content: NATIVE_TOOL_MARKUP_REMINDER });
	});

	it("returns empty after one retry instead of looping", async () => {
		const seen = stubSequence([swallowed, swallowed, ok("never reached")]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		expect(await call([{ role: "user", content: "hi" }])).toBe("");
		expect(seen.length).toBe(2);
	});

	it("uses one retry in total when a 500 is followed by a swallowed reply", async () => {
		const seen = stubSequence([parserEof, swallowed, ok("never reached")]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		expect(await call([{ role: "user", content: "hi" }])).toBe("");
		expect(seen.length).toBe(2);
	});

	it("does not retry an empty reply that generated no tokens, or other providers", async () => {
		const noTokens = stubSequence([
			() => Response.json({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }),
			ok("never reached"),
		]);
		expect(await buildTextToolCall({ provider: "ollama", model: "m" })([{ role: "user", content: "hi" }])).toBe("");
		expect(noTokens.length).toBe(1);

		const lm = stubSequence([swallowed, ok("never reached")]);
		expect(await buildTextToolCall({ provider: "lmstudio", model: "m" })([{ role: "user", content: "hi" }])).toBe("");
		expect(lm.length).toBe(1);
	});

	it("reports usage for both calls, since both really ran", async () => {
		stubSequence([swallowed, ok("done", { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 })]);
		const usage: TextToolUsage[] = [];
		const call = buildTextToolCall({ provider: "ollama", model: "m", onUsage: (u) => usage.push(u) });
		await call([{ role: "user", content: "hi" }]);
		expect(usage).toEqual([
			{ promptTokens: 50, completionTokens: 113, totalTokens: 163 },
			{ promptTokens: 9, completionTokens: 2, totalTokens: 11 },
		]);
	});
});
