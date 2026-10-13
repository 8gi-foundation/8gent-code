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
import { describeLocalTurnFailure, isLocalTurnFailureReply } from "../eight/local-turn-error";
import { TurnTimeoutError } from "../eight/turn-timeout";
import {
	_resetQwenVariantCache,
	_resetVisionCache,
	answerFromRawQwen,
	buildTextToolCall,
	DEFAULT_MAX_OUTPUT_TOKENS,
	extractUsage,
	isNativeToolParserFailure,
	isOllamaNoThink,
	isToolsUnsupported,
	MAX_STREAMED_LINE_BYTES,
	MAX_STREAMED_REPLY_BYTES,
	modelSupportsVision,
	readStreamedChatCompletion,
	readStreamedGenerate,
	StreamedReplyError,
	NATIVE_TOOL_MARKUP_REMINDER,
	ollamaRootFromEndpoint,
	qwenVariantFromModelfile,
	normaliseOllamaHost,
	renderQwenChatML,
	resolveMaxOutputTokens,
	resolveOllamaBaseUrl,
	resolveTextToolEndpoint,
	shouldDeclareTools,
	type TextToolUsage,
	toolCallsFromMessage,
	toWireMessage,
} from "./text-tool-endpoint";
import { resolveBaseUrl as resolveOllamaClientBaseUrl } from "../eight/clients/ollama";
import { runTextToolAgent, unknownToolResult } from "./text-tool-loop";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
	_resetQwenVariantCache();
	_resetVisionCache();
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
// Ollama's /api/show (the renderer lookup on the parser-failure path) is
// answered separately: 404 by default, so the raw path is skipped, or the given
// Modelfile. It is not recorded in `seen` and does not consume the sequence.
function stubSequence(responses: Array<() => Response>, modelfile?: string): SeenRequest[] {
	const seen: SeenRequest[] = [];
	let i = 0;
	globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
		if (String(input).endsWith("/api/show")) {
			return modelfile === undefined
				? new Response("not found", { status: 404 })
				: Response.json({ modelfile });
		}
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
		expect(err.message).toStartWith("ollama chat completions:");
		expect(err.message).toContain("built-in tool-call parser");
		expect(err.message).toContain("Raw re-request without the parser: skipped");
		expect(err.message).toContain("Retried once");
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

	it("fails with a clear error after one retry instead of looping or returning empty", async () => {
		const seen = stubSequence([swallowed, swallowed, ok("never reached")]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		const err = (await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e)) as Error;
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain("built-in tool-call parser");
		expect(err.message).toContain("empty reply for 113 generated tokens");
		expect(seen.length).toBe(2);
	});

	it("uses one retry in total when a 500 is followed by a swallowed reply", async () => {
		const seen = stubSequence([parserEof, swallowed, ok("never reached")]);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		const err = (await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e)) as Error;
		expect(err.message).toContain("EOF");
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

// ── Root-cause recovery: Ollama's raw generate path skips the model's PARSER ──
// Reproduced on 2026-09-30 against Ollama 0.34.4 + qwen3.8:27b-mlx: a reply of
// `<tool_call>\n{json}\n</tool_call>` is a 500 "EOF" on /v1/chat/completions,
// /api/chat and /api/generate, and a 200 with the text untouched on
// /api/generate with raw:true.
describe("renderQwenChatML (mirror of Ollama's qwen3.5 / qwen3.8 renderer)", () => {
	const convo = [
		{ role: "system" as const, content: "  sys rules  " },
		{ role: "user" as const, content: "fix it" },
		{ role: "assistant" as const, content: "```tool_call\n{}\n```" },
		{ role: "user" as const, content: "Tool result: ok" },
	];

	it("qwen3.8: xhigh reasoning line in the system turn, think block on every assistant turn", () => {
		expect(renderQwenChatML(convo, "qwen3.8")).toBe(
			"<|im_start|>system\nReasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.\n\nsys rules<|im_end|>\n" +
				"<|im_start|>user\nfix it<|im_end|>\n" +
				"<|im_start|>assistant\n<think>\n\n</think>\n\n```tool_call\n{}\n```<|im_end|>\n" +
				"<|im_start|>user\nTool result: ok<|im_end|>\n" +
				"<|im_start|>assistant\n<think>\n",
		);
	});

	it("qwen3.5: no reasoning line, no think block on assistant turns before the last query", () => {
		expect(renderQwenChatML(convo, "qwen3.5")).toBe(
			"<|im_start|>system\nsys rules<|im_end|>\n" +
				"<|im_start|>user\nfix it<|im_end|>\n" +
				"<|im_start|>assistant\n```tool_call\n{}\n```<|im_end|>\n" +
				"<|im_start|>user\nTool result: ok<|im_end|>\n" +
				"<|im_start|>assistant\n<think>\n",
		);
	});

	it("renders consecutive tool messages as one <tool_response> user turn", () => {
		const out = renderQwenChatML(
			[
				{ role: "user", content: "q" },
				{ role: "tool", content: "a" },
				{ role: "tool", content: "b" },
			],
			"qwen3.5",
		);
		expect(out).toContain(
			"<|im_start|>user\n<tool_response>\na\n</tool_response>\n<tool_response>\nb\n</tool_response><|im_end|>\n",
		);
	});
});

describe("raw-path helpers", () => {
	it("answerFromRawQwen keeps only the text after </think>", () => {
		expect(answerFromRawQwen("reasoning here\n</think>\n\nThe answer.<|im_end|>")).toBe("The answer.");
		expect(answerFromRawQwen("still thinking, cut off")).toBe("");
	});

	it("qwenVariantFromModelfile reads the RENDERER line only", () => {
		expect(qwenVariantFromModelfile("FROM x\nTEMPLATE {{ .Prompt }}\nRENDERER qwen3.8\nPARSER qwen3.5\n")).toBe("qwen3.8");
		expect(qwenVariantFromModelfile("FROM x\nRENDERER qwen3.5\n")).toBe("qwen3.5");
		expect(qwenVariantFromModelfile("FROM x\nRENDERER glm47\n")).toBeNull();
		expect(qwenVariantFromModelfile("FROM x\nPARSER qwen3.5\n")).toBeNull();
	});

	it("ollamaRootFromEndpoint strips the chat suffix in any convention", () => {
		expect(ollamaRootFromEndpoint("http://127.0.0.1:21434/v1/chat/completions")).toBe("http://127.0.0.1:21434");
		expect(ollamaRootFromEndpoint("http://h:11434/v1/")).toBe("http://h:11434");
		expect(ollamaRootFromEndpoint("http://h:11434")).toBe("http://h:11434");
	});
});

describe("buildTextToolCall recovers through Ollama's raw path", () => {
	const QWEN38 = "FROM qwen3.8:27b-mlx\nTEMPLATE {{ .Prompt }}\nRENDERER qwen3.8\nPARSER qwen3.5\n";
	const NATIVE_REPLY = '<tool_call>\n{"name": "run_command", "arguments": {"command": "bun test"}}\n</tool_call>';
	const rawOk = (response: string) => () =>
		Response.json({ response, done: true, prompt_eval_count: 40, eval_count: 21 });

	type Seen = { url: string; body: Record<string, unknown> };
	function stubRouted(responses: Array<() => Response>, modelfile: string | null): Seen[] {
		const seen: Seen[] = [];
		let i = 0;
		globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
			const url = String(input);
			if (url.endsWith("/api/show")) {
				return modelfile === null ? new Response("nope", { status: 404 }) : Response.json({ modelfile });
			}
			seen.push({ url, body: JSON.parse(init?.body ?? "{}") });
			const next = responses[Math.min(i, responses.length - 1)];
			i++;
			return next();
		}) as unknown as typeof fetch;
		return seen;
	}

	it("on a parser 500, re-requests the SAME conversation raw and returns the model's text untouched", async () => {
		const seen = stubRouted([parserEof, rawOk(`I will run the tests.\n</think>\n\n${NATIVE_REPLY}`)], QWEN38);
		const usage: TextToolUsage[] = [];
		const call = buildTextToolCall({
			provider: "ollama",
			model: "qwen3.8:27b-mlx",
			baseUrl: "http://127.0.0.1:21434",
			onUsage: (u) => usage.push(u),
		});
		const content = await call([
			{ role: "system", content: "sys" },
			{ role: "user", content: "fix the tests" },
		]);

		expect(content).toBe(NATIVE_REPLY);
		expect(seen.map((s) => s.url)).toEqual([
			"http://127.0.0.1:21434/v1/chat/completions",
			"http://127.0.0.1:21434/api/generate",
		]);
		const raw = seen[1].body;
		expect(raw.raw).toBe(true);
		expect(raw.model).toBe("qwen3.8:27b-mlx");
		expect(String(raw.prompt)).toContain("<|im_start|>user\nfix the tests<|im_end|>\n");
		expect(String(raw.prompt)).toEndWith("<|im_start|>assistant\n<think>\n");
		// No reminder: the model is asked the same question, not a different one.
		expect(String(raw.prompt)).not.toContain(NATIVE_TOOL_MARKUP_REMINDER);
		expect(usage).toEqual([{ promptTokens: 40, completionTokens: 21, totalTokens: 61 }]);
	});

	it("also recovers a reply the parser silently swallowed", async () => {
		const swallowed = () =>
			Response.json({ choices: [{ message: { content: "" } }], usage: { prompt_tokens: 5, completion_tokens: 30, total_tokens: 35 } });
		const seen = stubRouted([swallowed, rawOk("ok\n</think>\n\nAll tests pass.")], QWEN38);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		expect(await call([{ role: "user", content: "hi" }])).toBe("All tests pass.");
		expect(seen.length).toBe(2);
	});

	it("falls back to the one reminder retry when the raw request fails", async () => {
		const seen = stubRouted(
			[parserEof, () => new Response("boom", { status: 500 }), ok("```tool_call\n{\"name\":\"x\"}\n```")],
			QWEN38,
		);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		expect(await call([{ role: "user", content: "hi" }])).toContain("```tool_call");
		expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
			"/v1/chat/completions",
			"/api/generate",
			"/v1/chat/completions",
		]);
		expect((seen[2].body.messages as Array<{ content: string }>).at(-1)?.content).toBe(
			NATIVE_TOOL_MARKUP_REMINDER,
		);
	});

	it("names every step it tried when all recoveries fail, and never returns empty", async () => {
		const seen = stubRouted([parserEof, rawOk("thinking forever, never closed"), parserEof], QWEN38);
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		const err = (await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e)) as Error;
		expect(seen.length).toBe(3);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain("native tool-call markup");
		expect(err.message).toContain("Raw re-request without the parser: failed");
		expect(err.message).toContain("no answer after the think block");
		expect(err.message).toContain("Retried once with a format reminder");
	});

	it("skips the raw path for a model whose renderer it cannot reproduce", async () => {
		const seen = stubRouted([parserEof, ok("recovered")], "FROM llama\nTEMPLATE {{ .Prompt }}\n");
		const call = buildTextToolCall({ provider: "ollama", model: "m" });
		expect(await call([{ role: "user", content: "hi" }])).toBe("recovered");
		expect(seen.every((s) => s.url.endsWith("/v1/chat/completions"))).toBe(true);
	});
});

describe("a text-tool turn hit by the Ollama parser 500 ends with a reply, never empty", () => {
	const QWEN38 = "RENDERER qwen3.8\n";
	const tools = [
		{
			spec: { name: "run_command", description: "run", parameters: { type: "object", properties: {} } },
			run: async (args: Record<string, unknown>) => `ran ${String(args.command)}: 5 pass`,
		},
	];

	function stubScript(steps: Array<(url: string) => Response>): string[] {
		const urls: string[] = [];
		let i = 0;
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.endsWith("/api/show")) return Response.json({ modelfile: QWEN38 });
			urls.push(new URL(url).pathname);
			const step = steps[Math.min(i, steps.length - 1)];
			i++;
			return step(url);
		}) as unknown as typeof fetch;
		return urls;
	}

	it("recovers: the native call from the raw reply runs, and the turn ends with the model's answer", async () => {
		const urls = stubScript([
			() => parserEof(),
			() =>
				Response.json({
					response:
						'run them\n</think>\n\n<tool_call>\n<function=run_command>\n<parameter=command>\nbun test\n</parameter>\n</function>\n</tool_call>',
				}),
			() => ok("DONE: All 5 tests pass; the off-by-one in paginate was the bug.")(),
		]);
		const call = buildTextToolCall({ provider: "ollama", model: "qwen3.8:27b-mlx" });
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "fix the tests" }],
			tools,
			call,
			maxRounds: 4,
		});
		expect(result.toolLog.map((t) => [t.name, t.args])).toEqual([["run_command", { command: "bun test" }]]);
		expect(result.content).toContain("All 5 tests pass");
		expect(urls.slice(0, 3)).toEqual(["/v1/chat/completions", "/api/generate", "/v1/chat/completions"]);
	});

	it("unrecoverable: the turn rejects with a clear message the agent shows, never an empty reply", async () => {
		stubScript([() => parserEof()]);
		const call = buildTextToolCall({ provider: "ollama", model: "qwen3.8:27b-mlx" });
		const err = (await runTextToolAgent({
			messages: [{ role: "user", content: "fix the tests" }],
			tools,
			call,
		}).catch((e: unknown) => e)) as Error;
		const failure = describeLocalTurnFailure(err, {
			endpoint: "http://localhost:11434/v1/chat/completions",
			timeoutMs: 60_000,
		});
		expect(failure.message.trim().length).toBeGreaterThan(0);
		expect(failure.message).toStartWith("The local model turn could not complete:");
		expect(failure.message).toContain("built-in tool-call parser");
		expect(isLocalTurnFailureReply(failure.message)).toBe(true);
	});
});

// Ollama's qwen PARSER succeeds on native <tool_call> markup: it strips the call
// from `content` and returns it in `message.tool_calls` (only when the request
// declared the tool; without `tools` it is dropped). Captured shape from
// qwen3.8:27b-mlx on Ollama 0.34.4, 2026-09-30.
const structuredReply = (content: string, calls: Array<{ name: string; arguments: unknown }>) => () =>
	Response.json({
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content,
					tool_calls: calls.map((c, i) => ({
						id: `call_${i}`,
						index: i,
						type: "function",
						function: { name: c.name, arguments: c.arguments },
					})),
				},
				finish_reason: "tool_calls",
			},
		],
		usage: { prompt_tokens: 462, completion_tokens: 51, total_tokens: 513 },
	});

describe("toolCallsFromMessage (Ollama/OpenAI message.tool_calls)", () => {
	it("reads string and object arguments, in order", () => {
		expect(
			toolCallsFromMessage({
				tool_calls: [
					{ function: { name: "read_file", arguments: '{"path":"README.md"}' } },
					{ function: { name: "list_files", arguments: { path: "." } } },
					{ function: { name: "git_status" } },
				],
			}),
		).toEqual([
			{ name: "read_file", arguments: { path: "README.md" } },
			{ name: "list_files", arguments: { path: "." } },
			{ name: "git_status", arguments: {} },
		]);
	});

	it("skips entries with no name or arguments that are not an object", () => {
		expect(
			toolCallsFromMessage({
				tool_calls: [
					{ function: { arguments: "{}" } },
					{ function: { name: "a", arguments: "not json" } },
					{ function: { name: "b", arguments: "[1,2]" } },
					null,
				],
			}),
		).toEqual([]);
		expect(toolCallsFromMessage({ content: "hi" })).toEqual([]);
		expect(toolCallsFromMessage(undefined)).toEqual([]);
	});
});

describe("shouldDeclareTools / isToolsUnsupported", () => {
	const spec = { name: "read_file", description: "", parameters: {} };
	it("declares only for ollama with tools, unless switched off", () => {
		expect(shouldDeclareTools("ollama", [spec], {})).toBe(true);
		expect(shouldDeclareTools("ollama", [], {})).toBe(false);
		expect(shouldDeclareTools("ollama", undefined, {})).toBe(false);
		expect(shouldDeclareTools("lmstudio", [spec], {})).toBe(false);
		expect(shouldDeclareTools("ollama", [spec], { EIGHT_TEXT_TOOLS_DECLARE: "0" })).toBe(false);
	});
	it("recognises Ollama's no-tool-support 400 only", () => {
		expect(isToolsUnsupported(400, '{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}')).toBe(true);
		expect(isToolsUnsupported(500, "does not support tools")).toBe(false);
		expect(isToolsUnsupported(400, '{"error":"bad request"}')).toBe(false);
	});
});

describe("buildTextToolCall returns structured tool_calls instead of losing them", () => {
	const specs = [
		{ name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
	];

	it("declares the registered tools to ollama and returns prose plus the structured call", async () => {
		const seen = stubSequence([
			structuredReply("Let me check the root README.", [{ name: "read_file", arguments: '{"path":"README.md"}' }]),
		]);
		const call = buildTextToolCall({ provider: "ollama", model: "qwen3.8:27b-mlx", tools: specs });
		const reply = await call([{ role: "user", content: "read it" }]);
		expect(reply).toEqual({
			content: "Let me check the root README.",
			toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }],
		});
		const body = seen[0] as unknown as { tools?: Array<{ function: { name: string } }> };
		expect(body.tools?.map((t) => t.function.name)).toEqual(["read_file"]);
	});

	it("an empty content with tool_calls is a call, not a swallowed reply (no recovery request)", async () => {
		const seen = stubSequence([structuredReply("", [{ name: "read_file", arguments: { path: "a.ts" } }])]);
		const call = buildTextToolCall({ provider: "ollama", model: "m", tools: specs });
		const reply = await call([{ role: "user", content: "x" }]);
		expect(reply).toEqual({ content: "", toolCalls: [{ name: "read_file", arguments: { path: "a.ts" } }] });
		expect(seen.length).toBe(1);
	});

	it("never declares tools to other providers, and a plain reply stays a string", async () => {
		const seen = stubSequence([ok("hello")]);
		const call = buildTextToolCall({ provider: "lmstudio", model: "m", tools: specs });
		expect(await call([{ role: "user", content: "x" }])).toBe("hello");
		expect("tools" in (seen[0] as object)).toBe(false);
	});

	it("resends without tools when the model does not support them, and stops declaring", async () => {
		const seen = stubSequence([
			() => Response.json({ error: "registry.ollama.ai/library/g:2b does not support tools" }, { status: 400 }),
			ok("first"),
			ok("second"),
		]);
		const call = buildTextToolCall({ provider: "ollama", model: "g:2b", tools: specs });
		expect(await call([{ role: "user", content: "x" }])).toBe("first");
		expect(await call([{ role: "user", content: "y" }])).toBe("second");
		expect(seen.map((b) => "tools" in (b as object))).toEqual([true, false, false]);
	});
});

describe("a text-tool turn whose call came back as structured tool_calls runs it", () => {
	const ran: string[] = [];
	const tools = [
		{
			spec: { name: "read_file", description: "read", parameters: { type: "object", properties: {} } },
			run: async (args: Record<string, unknown>) => {
				ran.push(String(args.path));
				return `# contents of ${String(args.path)}`;
			},
		},
	];

	it("runs the structured call (was: prose-only reply, turn ended, nothing written)", async () => {
		ran.length = 0;
		stubSequence([
			structuredReply("Let me check tooling and the root README.", [
				{ name: "read_file", arguments: '{"path":"README.md"}' },
			]),
			ok("DONE: The README has a Deck section."),
		]);
		const call = buildTextToolCall({ provider: "ollama", model: "qwen3.8:27b-mlx", tools: tools.map((t) => t.spec) });
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "check the README" }],
			tools,
			call,
			maxRounds: 4,
		});
		expect(ran).toEqual(["README.md"]);
		expect(result.toolLog.map((t) => t.name)).toEqual(["read_file"]);
		expect(result.content).toContain("Deck section");
	});

	// #3091: the unregistered call used to be dropped without a word. It still
	// never runs, but it is answered with an error the model can act on.
	it("never runs a structured call to an unregistered tool, and tells the model so", async () => {
		ran.length = 0;
		const seen = stubSequence([
			structuredReply("On it.", [{ name: "delete_everything", arguments: "{}" }]),
			ok("DONE: nothing to do."),
		]);
		const call = buildTextToolCall({ provider: "ollama", model: "m", tools: tools.map((t) => t.spec) });
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "x" }],
			tools,
			call,
			maxRounds: 2,
		});
		expect(ran).toEqual([]);
		expect(result.toolLog).toEqual([
			{ name: "delete_everything", args: {}, result: unknownToolResult("delete_everything", ["read_file"]) },
		]);
		const fedBack = JSON.stringify(seen[1]);
		expect(fedBack).toContain('no tool named \\"delete_everything\\"');
	});

	// #3091, the pilot shape (run 2026-09-30_055542, l4-spawn-parallel-m5):
	// after a read round, qwen3.8 answered with structured spawn_agent calls
	// and empty text three times. The calls were dropped, two completion checks
	// told the model it had called nothing, and the third empty reply became
	// the answer: "" with status ok.
	it("a turn of structured calls to a missing tool never ends as an empty answer", async () => {
		ran.length = 0;
		const spawn = () =>
			structuredReply("", [
				{
					name: "spawn_agent",
					arguments: '{"runtime":"8gent","model":"llama3.2:3b","task":"Fix ONLY src/wordcount.ts"}',
				},
			])();
		const seen = stubSequence([
			structuredReply("", [{ name: "read_file", arguments: '{"path":"README.md"}' }]),
			spawn,
			spawn,
			spawn,
			spawn,
			spawn,
		]);
		const call = buildTextToolCall({ provider: "ollama", model: "qwen3.8:27b-mlx", tools: tools.map((t) => t.spec) });
		const result = await runTextToolAgent({
			messages: [{ role: "user", content: "Fix it: call spawn_agent with model llama3.2:3b." }],
			tools,
			call,
			maxRounds: 6,
		});
		expect(ran).toEqual(["README.md"]);
		const spawns = result.toolLog.filter((e) => e.name === "spawn_agent");
		expect(spawns.length).toBeGreaterThan(0);
		for (const s of spawns) expect(s.result).toBe(unknownToolResult("spawn_agent", ["read_file"]));
		expect(JSON.stringify(seen[2])).toContain('no tool named \\"spawn_agent\\"');
		expect(result.content.trim()).not.toBe("");
		expect(result.unverified.length).toBeGreaterThan(0);
	});
});

// #3074: pilot run 2026-09-30_031816, turn D. llama3.2:3b fell into a repetition
// loop and generated 41,341 tokens over 13 minutes on ONE step; the request had
// no max_tokens and was non-streaming, so the TUI showed "0 tok" throughout and
// only the 20 min turn timeout ended it. Every step now carries an output cap,
// and a reply the cap cut off fails loudly instead of posing as an answer.
describe("buildTextToolCall output cap (#3074)", () => {
	type Seen = { url: string; body: Record<string, unknown> };
	function stubCapped(responses: Array<() => Response>, modelfile: string | null = null): Seen[] {
		const seen: Seen[] = [];
		let i = 0;
		globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
			const url = String(input);
			if (url.endsWith("/api/show")) {
				return modelfile === null
					? new Response("nope", { status: 404 })
					: Response.json({ modelfile });
			}
			seen.push({ url, body: JSON.parse(init?.body ?? "{}") });
			const next = responses[Math.min(i, responses.length - 1)];
			i++;
			return next();
		}) as unknown as typeof fetch;
		return seen;
	}
	const finished = (content: string, finish_reason: string) => () =>
		Response.json({
			choices: [{ message: { content }, finish_reason }],
			usage: { prompt_tokens: 4730, completion_tokens: 8192, total_tokens: 12922 },
		});

	it("sends the resolved cap as max_tokens on every chat request", async () => {
		const seen = stubCapped([finished("done", "stop")]);
		const call = buildTextToolCall({ provider: "ollama", model: "llama3.2:3b" });
		expect(await call([{ role: "user", content: "hi" }])).toBe("done");
		expect(seen[0].body.max_tokens).toBe(resolveMaxOutputTokens());
		expect(seen[0].body.max_tokens).toBeGreaterThan(0);
		// Streamed by default since #3657 (judged by progress, not wall time).
		expect(seen[0].body.stream).toBe(true);
	});

	it("honours an explicit maxTokens", async () => {
		const seen = stubCapped([finished("done", "stop")]);
		const call = buildTextToolCall({ provider: "lmstudio", model: "m", maxTokens: 512 });
		await call([{ role: "user", content: "hi" }]);
		expect(seen[0].body.max_tokens).toBe(512);
	});

	it("fails the step, naming the cap and the knob, when the reply was cut off", async () => {
		stubCapped([finished("Fixed bug. Fixed bug. Fixed bug. Fixed bug.", "length")]);
		const usage: TextToolUsage[] = [];
		const call = buildTextToolCall({
			provider: "ollama",
			model: "llama3.2:3b",
			maxTokens: 8192,
			onUsage: (u) => usage.push(u),
		});
		const run = call([{ role: "user", content: "fix it" }]);
		await expect(run).rejects.toThrow("ollama/llama3.2:3b hit the 8192-token output cap");
		await expect(run).rejects.toThrow("EIGHT_MAX_OUTPUT_TOKENS");
		// The real usage is still reported, so token totals stay true.
		expect(usage).toEqual([{ promptTokens: 4730, completionTokens: 8192, totalTokens: 12922 }]);
	});

	it("the raw recovery path carries the same cap as num_predict and treats a cut-off as a failure", async () => {
		const QWEN38 =
			"FROM qwen3.8:27b-mlx\nTEMPLATE {{ .Prompt }}\nRENDERER qwen3.8\nPARSER qwen3.5\n";
		const seen = stubCapped(
			[
				() => new Response(OLLAMA_PARSER_EOF, { status: 500 }),
				() => Response.json({ response: "loop loop loop", done: true, done_reason: "length" }),
				finished("All tests pass.", "stop"),
			],
			QWEN38,
		);
		const call = buildTextToolCall({
			provider: "ollama",
			model: "qwen3.8:27b-mlx",
			maxTokens: 1000,
		});
		expect(await call([{ role: "user", content: "hi" }])).toBe("All tests pass.");
		expect(seen.map((s) => s.url.replace(/^http:\/\/[^/]+/, ""))).toEqual([
			"/v1/chat/completions",
			"/api/generate",
			"/v1/chat/completions",
		]);
		expect((seen[1].body.options as Record<string, unknown>).num_predict).toBe(1000);
		expect(seen[2].body.max_tokens).toBe(1000);
	});
});

describe("resolveMaxOutputTokens (#3074)", () => {
	it("defaults when unset, empty, zero, negative or not a number", () => {
		for (const v of [undefined, "", "0", "-5", "lots"]) {
			expect(resolveMaxOutputTokens({ EIGHT_MAX_OUTPUT_TOKENS: v })).toBe(
				DEFAULT_MAX_OUTPUT_TOKENS,
			);
		}
	});
	it("uses a positive override, floored to an integer", () => {
		expect(resolveMaxOutputTokens({ EIGHT_MAX_OUTPUT_TOKENS: "16384" })).toBe(16384);
		expect(resolveMaxOutputTokens({ EIGHT_MAX_OUTPUT_TOKENS: "300.7" })).toBe(300);
	});
});

// #3076: the pilot's "-m5" scenarios set OLLAMA_HOST and OLLAMA_BASE_URL to an
// SSH tunnel, yet every text-tool step landed on this machine's ollama: the
// endpoint fell back to a hardcoded localhost:11434 and read neither variable.
describe("Ollama base URL honours OLLAMA_BASE_URL / OLLAMA_HOST (#3076)", () => {
	const KEYS = ["OLLAMA_BASE_URL", "OLLAMA_HOST", "TRAINING_PROXY_URL"] as const;
	function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
		const prev = KEYS.map((k) => [k, process.env[k]] as const);
		for (const k of KEYS) Reflect.deleteProperty(process.env, k);
		Object.assign(process.env, vars);
		try {
			fn();
		} finally {
			for (const [k, v] of prev) {
				if (v === undefined) Reflect.deleteProperty(process.env, k);
				else process.env[k] = v;
			}
		}
	}

	it("the text-tool endpoint follows OLLAMA_BASE_URL", () => {
		withEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:21434" }, () => {
			expect(resolveTextToolEndpoint("ollama")).toBe("http://127.0.0.1:21434/v1/chat/completions");
		});
	});

	it("falls back to OLLAMA_HOST, normalising a bare host:port", () => {
		withEnv({ OLLAMA_HOST: "127.0.0.1:21434" }, () => {
			expect(resolveTextToolEndpoint("ollama")).toBe("http://127.0.0.1:21434/v1/chat/completions");
		});
	});

	it("OLLAMA_BASE_URL wins over OLLAMA_HOST", () => {
		withEnv({ OLLAMA_BASE_URL: "http://a:1/v1", OLLAMA_HOST: "b:2" }, () => {
			expect(resolveTextToolEndpoint("ollama")).toBe("http://a:1/v1/chat/completions");
		});
	});

	it("uses localhost only when neither is set, and a per-session baseUrl still wins", () => {
		withEnv({}, () => {
			expect(resolveTextToolEndpoint("ollama")).toBe("http://localhost:11434/v1/chat/completions");
		});
		withEnv({ OLLAMA_HOST: "b:2" }, () => {
			expect(resolveTextToolEndpoint("ollama", "http://pinned:9")).toBe("http://pinned:9/v1/chat/completions");
			// Other providers are untouched by Ollama's variables.
			expect(resolveTextToolEndpoint("lmstudio")).toBe("http://localhost:1234/v1/chat/completions");
		});
	});

	it("a real buildTextToolCall request goes to the env host", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			urls.push(String(input));
			return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
		}) as unknown as typeof fetch;
		let call: ReturnType<typeof buildTextToolCall> | undefined;
		withEnv({ OLLAMA_HOST: "127.0.0.1:21434" }, () => {
			call = buildTextToolCall({ provider: "ollama", model: "m" });
		});
		expect(await call?.([{ role: "user", content: "hi" }])).toBe("ok");
		expect(urls).toEqual(["http://127.0.0.1:21434/v1/chat/completions"]);
	});

	it("the native ollama client resolves the same root", () => {
		withEnv({ OLLAMA_HOST: "127.0.0.1:21434" }, () => {
			expect(resolveOllamaClientBaseUrl()).toBe("http://127.0.0.1:21434");
		});
		withEnv({ OLLAMA_BASE_URL: "http://127.0.0.1:21434/v1" }, () => {
			expect(resolveOllamaClientBaseUrl()).toBe("http://127.0.0.1:21434");
		});
		withEnv({}, () => {
			expect(resolveOllamaClientBaseUrl()).toBe("http://localhost:11434");
			expect(resolveOllamaClientBaseUrl("http://explicit:1")).toBe("http://explicit:1");
		});
	});

	it("normaliseOllamaHost and resolveOllamaBaseUrl", () => {
		expect(normaliseOllamaHost("127.0.0.1:21434")).toBe("http://127.0.0.1:21434");
		expect(normaliseOllamaHost("gpu-box")).toBe("http://gpu-box:11434");
		expect(normaliseOllamaHost("https://h.example/v1/")).toBe("https://h.example");
		expect(normaliseOllamaHost("  ")).toBeNull();
		expect(normaliseOllamaHost(undefined)).toBeNull();
		expect(resolveOllamaBaseUrl({ OLLAMA_BASE_URL: "", OLLAMA_HOST: "x:1" })).toBe("http://x:1");
		expect(resolveOllamaBaseUrl({})).toBe("http://localhost:11434");
	});
});

describe("EIGHT_OLLAMA_NO_THINK turns thinking off per Ollama model", () => {
	const env = { EIGHT_OLLAMA_NO_THINK: " qwen3.5:9b , other:1b" };

	it("matches only listed models on the ollama provider", () => {
		expect(isOllamaNoThink("ollama", "qwen3.5:9b", env)).toBe(true);
		expect(isOllamaNoThink("ollama", "other:1b", env)).toBe(true);
		expect(isOllamaNoThink("ollama", "qwen3.8:27b-mlx", env)).toBe(false);
		expect(isOllamaNoThink("lmstudio", "qwen3.5:9b", env)).toBe(false);
		expect(isOllamaNoThink("ollama", "qwen3.5:9b", {})).toBe(false);
	});

	function captureBodies(): Array<Record<string, unknown>> {
		const bodies: Array<Record<string, unknown>> = [];
		globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
			bodies.push(JSON.parse(init?.body ?? "{}"));
			return Response.json({ choices: [{ message: { content: "ok" } }] });
		}) as unknown as typeof fetch;
		return bodies;
	}

	it("sends reasoning_effort none for a listed model, and nothing for any other", async () => {
		const prev = process.env.EIGHT_OLLAMA_NO_THINK;
		process.env.EIGHT_OLLAMA_NO_THINK = "qwen3.5:9b";
		try {
			const bodies = captureBodies();
			await buildTextToolCall({ provider: "ollama", model: "qwen3.5:9b" })([{ role: "user", content: "hi" }]);
			await buildTextToolCall({ provider: "ollama", model: "qwen3.8:27b-mlx" })([{ role: "user", content: "hi" }]);
			expect(bodies[0].reasoning_effort).toBe("none");
			expect("reasoning_effort" in bodies[1]).toBe(false);
		} finally {
			if (prev === undefined) Reflect.deleteProperty(process.env, "EIGHT_OLLAMA_NO_THINK");
			else process.env.EIGHT_OLLAMA_NO_THINK = prev;
		}
	});

	it("renderQwenChatML with thinking off pre-closes the think block", () => {
		expect(renderQwenChatML([{ role: "user", content: "q" }], "qwen3.5", true)).toBe(
			"<|im_start|>user\nq<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
		);
	});
});

// #3641: a message with images goes to the OpenAI-compatible endpoint in the
// array form Ollama and LM Studio take for vision models; text-only messages
// are sent exactly as before.
describe("images on the wire (#3641)", () => {
	const URL1 = "data:image/png;base64,iVBORw0KGgo=";

	it("toWireMessage keeps a text message a plain string", () => {
		expect(toWireMessage({ role: "user", content: "hi" })).toEqual({ role: "user", content: "hi" });
		expect(toWireMessage({ role: "user", content: "hi", images: [] })).toEqual({ role: "user", content: "hi" });
	});

	it("toWireMessage turns images into text plus image_url parts", () => {
		expect(toWireMessage({ role: "user", content: "look", images: [URL1] })).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image_url", image_url: { url: URL1 } },
			],
		});
	});

	it("buildTextToolCall sends the array form for the message that has images, and strings for the rest", async () => {
		const seen = stubSequence([ok("I see a Save button.")]);
		const call = buildTextToolCall({ provider: "ollama", model: "qwen3.5:9b" });
		await call([
			{ role: "system", content: "sys" },
			{ role: "user", content: "Where do I click?", images: [URL1] },
		]);
		const messages = (seen[0] as unknown as { messages: Array<{ role: string; content: unknown }> }).messages;
		expect(messages[0]).toEqual({ role: "system", content: "sys" });
		expect(messages[1]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "Where do I click?" },
				{ type: "image_url", image_url: { url: URL1 } },
			],
		});
	});
});

// #3641: whether the model can see decides whether it is ever sent pixels.
// Ollama answers through /api/show `capabilities`; other local servers go by
// the model family. Nothing known means no.
describe("modelSupportsVision (#3641)", () => {
	function stubShow(answer: (model: string) => Response): string[] {
		const asked: string[] = [];
		globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
			if (!String(input).endsWith("/api/show")) throw new Error(`unexpected ${String(input)}`);
			const model = (JSON.parse(init?.body ?? "{}") as { model: string }).model;
			asked.push(model);
			return answer(model);
		}) as unknown as typeof fetch;
		return asked;
	}

	it("ollama: true when /api/show lists vision, false when it does not, one probe per model", async () => {
		const asked = stubShow((model) =>
			Response.json({
				capabilities: model === "qwen3.5:9b" ? ["completion", "vision", "tools"] : ["completion", "tools"],
			}),
		);
		expect(await modelSupportsVision({ provider: "ollama", model: "qwen3.5:9b" })).toBe(true);
		expect(await modelSupportsVision({ provider: "ollama", model: "8j:latest" })).toBe(false);
		// Cached: asking again sends nothing.
		expect(await modelSupportsVision({ provider: "ollama", model: "qwen3.5:9b" })).toBe(true);
		expect(await modelSupportsVision({ provider: "ollama", model: "8j:latest" })).toBe(false);
		expect(asked).toEqual(["qwen3.5:9b", "8j:latest"]);
	});

	it("ollama: a failed lookup is no, and is asked again next time", async () => {
		const asked = stubShow(() => new Response("not found", { status: 404 }));
		expect(await modelSupportsVision({ provider: "ollama", model: "m" })).toBe(false);
		expect(await modelSupportsVision({ provider: "ollama", model: "m" })).toBe(false);
		expect(asked).toEqual(["m", "m"]);
	});

	it("ollama: the probe goes to the pinned base URL's root", async () => {
		let url = "";
		globalThis.fetch = (async (input: unknown) => {
			url = String(input);
			return Response.json({ capabilities: ["completion", "vision"] });
		}) as unknown as typeof fetch;
		expect(
			await modelSupportsVision({ provider: "ollama", model: "m", baseUrl: "http://127.0.0.1:11435/v1" }),
		).toBe(true);
		expect(url).toBe("http://127.0.0.1:11435/api/show");
	});

	it("other local servers: the model family decides, no network", async () => {
		globalThis.fetch = (async () => {
			throw new Error("no network expected");
		}) as unknown as typeof fetch;
		expect(await modelSupportsVision({ provider: "lmstudio", model: "qwen2.5-vl-7b-instruct" })).toBe(true);
		expect(await modelSupportsVision({ provider: "lmstudio", model: "qwen3-14b" })).toBe(false);
	});
});

describe("streamed reply size caps (#3671)", () => {
	const streamOf = (chunks: string[]): Response =>
		new Response(
			new ReadableStream({
				start(c) {
					const enc = new TextEncoder();
					for (const k of chunks) c.enqueue(enc.encode(k));
					c.close();
				},
			}),
		);

	it("rejects a single line longer than the line cap", async () => {
		const huge = `data: {"choices":[{"delta":{"content":"${"a".repeat(MAX_STREAMED_LINE_BYTES + 10)}"}}]}`;
		const err = await readStreamedChatCompletion(streamOf([huge])).catch((e) => e);
		expect(err).toBeInstanceOf(StreamedReplyError);
		expect(String(err.message)).toContain("line exceeded");
	});

	it("rejects a body that grows past the reply cap across many small lines", async () => {
		const line = `{"response":"${"b".repeat(100_000)}"}\n`;
		const n = Math.ceil(MAX_STREAMED_REPLY_BYTES / line.length) + 2;
		const err = await readStreamedGenerate(streamOf(Array(n).fill(line))).catch((e) => e);
		expect(err).toBeInstanceOf(StreamedReplyError);
		expect(String(err.message)).toContain("reply exceeded");
	});

	it("still reads a normal streamed reply", async () => {
		const out = await readStreamedGenerate(
			streamOf(['{"response":"hi "}\n', '{"response":"there","done":true}\n']),
		);
		expect(out.response).toBe("hi there");
	});
});
