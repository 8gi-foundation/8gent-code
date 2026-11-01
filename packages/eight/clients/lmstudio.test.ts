/**
 * LMStudioClient reasoning-model handling.
 *
 * The reasoning model "ornith-1.0-9b" (and its kin) spend their token budget on
 * a hidden thinking trace FIRST, then emit the visible answer into `content`.
 * Two failure modes the shipped client used to hit:
 *   1. No `max_tokens` -> LM Studio's own default cut the model off mid-thought
 *      and `content` came back empty.
 *   2. The client only read `message.content`, so even when the answer had been
 *      pushed into `reasoning_content` it surfaced an empty string.
 *
 * These tests pin the fix IN THE PACKAGE (not just the mesh harness):
 *   - a generous `max_tokens` default (configurable), sent on every chat,
 *   - read `content` first, fall back to `reasoning_content` ONLY when content
 *     is empty/whitespace (never overriding a normal model's real content),
 *   - a truncated hidden chain-of-thought is NEVER returned as the answer: when
 *     content is empty AND finish_reason == "length", the client throws so the
 *     failure is surfaced instead of returning silent garbage.
 *
 * A guarded live smoke (env LMSTUDIO_LIVE=1) exercises the real ornith-1.0-9b at
 * :1234; it is OFF by default so the suite never depends on a running model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { LMStudioClient } from "./lmstudio";
import type { Message } from "../types";

const realFetch = globalThis.fetch;

// Captured outbound request body of the most recent stubbed fetch.
let lastBody: any = null;
let lastUrl: string | null = null;

/**
 * Stub global fetch with a canned /v1/chat/completions response, capturing the
 * request body so tests can assert on `max_tokens`. `choice` is spread into
 * `choices[0]`, so a test provides `{ message, finish_reason }`.
 */
function stubChat(choice: Record<string, unknown>, model = "ornith-1.0-9b"): void {
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		lastUrl = String(url);
		lastBody = init?.body ? JSON.parse(init.body as string) : null;
		return new Response(
			JSON.stringify({
				model,
				choices: [choice],
				usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	lastBody = null;
	lastUrl = null;
});

const MESSAGES: Message[] = [
	{ role: "system", content: "You are Karen, the security officer." },
	{ role: "user", content: "Is a fully local agent table a real security win?" },
];

describe("LMStudioClient reasoning handling", () => {
	test("normal (non-reasoning) response returns content unchanged", async () => {
		stubChat({
			message: { role: "assistant", content: "Yes - no cloud egress means no third-party trust." },
			finish_reason: "stop",
		});
		const client = new LMStudioClient("gemma-4-12b-coder");
		const res = await client.chat(MESSAGES);
		expect(res.message.content).toBe("Yes - no cloud egress means no third-party trust.");
	});

	test("reasoning-style response (empty content + reasoning_content) returns the reasoning answer", async () => {
		stubChat({
			message: {
				role: "assistant",
				content: "",
				reasoning_content: "Local inference removes the cloud egress path; watch key custody.",
			},
			finish_reason: "stop",
		});
		const client = new LMStudioClient("ornith-1.0-9b");
		const res = await client.chat(MESSAGES);
		expect(res.message.content).toBe(
			"Local inference removes the cloud egress path; watch key custody.",
		);
	});

	test("whitespace-only content also falls back to reasoning_content", async () => {
		stubChat({
			message: { role: "assistant", content: "   \n\t ", reasoning_content: "The answer." },
			finish_reason: "stop",
		});
		const client = new LMStudioClient("ornith-1.0-9b");
		const res = await client.chat(MESSAGES);
		expect(res.message.content).toBe("The answer.");
	});

	test("real content is NEVER overridden by reasoning_content when both are present", async () => {
		stubChat({
			message: {
				role: "assistant",
				content: "Final answer.",
				reasoning_content: "hidden scratch work that must not leak as the reply",
			},
			finish_reason: "stop",
		});
		const client = new LMStudioClient("ornith-1.0-9b");
		const res = await client.chat(MESSAGES);
		expect(res.message.content).toBe("Final answer.");
	});

	test("truncated hidden chain-of-thought (empty content + finish_reason=length) throws, never surfaced as the answer", async () => {
		stubChat({
			message: {
				role: "assistant",
				content: "",
				reasoning_content: "Let me think step by step. First I need to consider the",
			},
			finish_reason: "length",
		});
		const client = new LMStudioClient("ornith-1.0-9b");
		await expect(client.chat(MESSAGES)).rejects.toThrow(/finish_reason=length|token limit/i);
	});

	test("content present with finish_reason=length still returns the (partial) content", async () => {
		// Truncation with SOME content is not the empty-answer failure mode: return
		// what the model actually said rather than throwing.
		stubChat({
			message: { role: "assistant", content: "Yes, because" },
			finish_reason: "length",
		});
		const client = new LMStudioClient("ornith-1.0-9b");
		const res = await client.chat(MESSAGES);
		expect(res.message.content).toBe("Yes, because");
	});

	test("sends a max_tokens default (~4000) on every chat", async () => {
		stubChat({ message: { role: "assistant", content: "ok" }, finish_reason: "stop" });
		const client = new LMStudioClient("ornith-1.0-9b");
		await client.chat(MESSAGES);
		expect(lastBody?.max_tokens).toBe(4000);
	});

	test("max_tokens is configurable via the constructor", async () => {
		stubChat({ message: { role: "assistant", content: "ok" }, finish_reason: "stop" });
		const client = new LMStudioClient(
			"ornith-1.0-9b",
			"http://localhost:1234",
			"lm-studio",
			8192,
		);
		await client.chat(MESSAGES);
		expect(lastBody?.max_tokens).toBe(8192);
	});

	test("tool_calls are still parsed on the chat path", async () => {
		stubChat({
			message: {
				role: "assistant",
				content: "",
				tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
			},
			finish_reason: "tool_calls",
		});
		const client = new LMStudioClient("gemma-4-12b-coder");
		const res = await client.chat(MESSAGES);
		expect(res.message.tool_calls?.[0]?.function.name).toBe("read_file");
	});

	test("hits the /v1/chat/completions path on the configured base URL", async () => {
		stubChat({ message: { role: "assistant", content: "ok" }, finish_reason: "stop" });
		const client = new LMStudioClient("ornith-1.0-9b", "http://127.0.0.1:1234");
		await client.chat(MESSAGES);
		expect(lastUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
	});
});

// ── Guarded live smoke (OFF by default) ─────────────────────────────────────
// Runs ONLY with LMSTUDIO_LIVE=1 and a real LM Studio serving ornith-1.0-9b at
// :1234. The suite never depends on a live model; this is opt-in evidence.
const LIVE = process.env.LMSTUDIO_LIVE === "1";

describe.skipIf(!LIVE)("LMStudioClient live smoke (ornith-1.0-9b @ :1234)", () => {
	test("returns non-empty content from the real reasoning model", async () => {
		globalThis.fetch = realFetch; // ensure no stub leaks in
		const base = process.env.LM_STUDIO_HOST || "http://127.0.0.1:1234";
		const client = new LMStudioClient("ornith-1.0-9b", base);
		const res = await client.chat([
			{ role: "system", content: "Answer in one short sentence." },
			{ role: "user", content: "Say the single word: ready." },
		]);
		expect(res.message.content.trim().length).toBeGreaterThan(0);
	}, 240_000);
});
