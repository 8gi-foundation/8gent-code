/**
 * #3553: judge a model step by silence, not total time.
 *
 * With EIGHT_STREAM_IDLE_MS set, the text-tool path streams its reply and the
 * step limit is a quiet-gap timer re-armed on every chunk, so a slow model that
 * keeps writing is never cut off, and a connection that goes silent is caught
 * after one quiet gap. The per-step wall clock stays as a higher ceiling, and
 * the output-token cap (#3074) still applies.
 *
 * The peers' numbers (a chunk every 20 s for 6 min at idle = 60 s) are scaled
 * down to milliseconds against a real local Bun server, so the suite runs in
 * seconds without models or network.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_STREAM_CEILING_MS,
	DEFAULT_STREAM_IDLE_MS,
	DEFAULT_TURN_TIMEOUT_MS,
	TurnTimeoutError,
	resolveStepCeilingMs,
	resolveStreamIdleMs,
} from "../eight/turn-timeout";
import { modelFetch } from "./model-fetch";
import {
	type TextToolUsage,
	buildTextToolCall,
	readStreamedChatCompletion,
} from "./text-tool-endpoint";

const enc = new TextEncoder();

// Requests the fake endpoint saw, keyed by path.
const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];

// A ReadableStream that writes each chunk after `gapMs`, then ends - or, with
// `hang`, never ends after the chunks.
function drip(chunks: string[], gapMs: number, hang = false): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		async pull(controller) {
			if (i < chunks.length) {
				if (i > 0) await Bun.sleep(gapMs);
				controller.enqueue(enc.encode(chunks[i++]));
				return;
			}
			if (hang) {
				await new Promise(() => {});
				return;
			}
			controller.close();
		},
	});
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

// An OpenAI-compatible streamed reply: content split across deltas, one tool
// call whose arguments arrive in pieces, then usage, then [DONE].
const STREAMED_CHAT = [
	sse({ choices: [{ index: 0, delta: { role: "assistant", content: "Read" } }] }),
	sse({ choices: [{ index: 0, delta: { content: "ing the " } }] }),
	sse({ choices: [{ index: 0, delta: { content: "README." } }] }),
	sse({
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "c1",
							type: "function",
							function: { name: "read_file", arguments: '{"pa' },
						},
					],
				},
			},
		],
	}),
	sse({
		choices: [
			{
				index: 0,
				delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] },
			},
		],
	}),
	sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
	sse({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }),
	"data: [DONE]\n\n",
];

let server: ReturnType<typeof Bun.serve> | null = null;
let base = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const gap = Number(url.searchParams.get("gap") ?? "0");
			const mode = url.searchParams.get("mode") ?? "";
			if (req.method === "POST") {
				const text = await req.text();
				try {
					bodies.push({ path: url.pathname, body: JSON.parse(text) });
				} catch {
					// not JSON; ignore
				}
			}
			if (mode === "plain") {
				// Ten small chunks, `gap` ms apart.
				const parts = Array.from({ length: 10 }, (_, n) => `chunk${n};`);
				return new Response(drip(parts, gap));
			}
			if (mode === "silent") {
				return new Response(drip(["first;"], 0, true));
			}
			if (mode === "chat") {
				return new Response(drip(STREAMED_CHAT, gap), {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			if (mode === "chat-silent") {
				return new Response(drip(STREAMED_CHAT.slice(0, 1), 0, true), {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			if (mode === "chat-length") {
				return new Response(
					drip(
						[
							sse({ choices: [{ index: 0, delta: { content: "again again " } }] }),
							sse({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }),
							"data: [DONE]\n\n",
						],
						gap,
					),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			return new Response("unknown mode", { status: 400 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
});

describe("resolveStreamIdleMs / resolveStepCeilingMs (EIGHT_STREAM_IDLE_MS)", () => {
	it("is on by default (#3657): the old 300 s wall clock becomes the no-progress gap", () => {
		expect(DEFAULT_STREAM_IDLE_MS).toBe(DEFAULT_TURN_TIMEOUT_MS);
		expect(resolveStreamIdleMs({})).toBe(DEFAULT_STREAM_IDLE_MS);
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "" })).toBe(DEFAULT_STREAM_IDLE_MS);
		// A typo never silently turns progress-based judging off.
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "abc" })).toBe(DEFAULT_STREAM_IDLE_MS);
		// With the gap on, the step wall clock is the higher safety net.
		expect(resolveStepCeilingMs({})).toBe(DEFAULT_STREAM_CEILING_MS);
	});

	it("0 or off turns the gap off and the step limit is the 300 s wall clock again", () => {
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "0" })).toBeNull();
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "off" })).toBeNull();
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "-5" })).toBeNull();
		expect(resolveStepCeilingMs({ EIGHT_STREAM_IDLE_MS: "0" })).toBe(DEFAULT_TURN_TIMEOUT_MS);
		expect(resolveStepCeilingMs({ EIGHT_STREAM_IDLE_MS: "0", EIGHT_TURN_TIMEOUT_MS: "5000" })).toBe(
			5000,
		);
	});

	it("reads a positive idle gap with a 1 s floor", () => {
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "60000" })).toBe(60_000);
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "10" })).toBe(1000);
	});

	it("an explicit EIGHT_TURN_TIMEOUT_MS is always the ceiling, gap on or off", () => {
		expect(resolveStepCeilingMs({ EIGHT_STREAM_IDLE_MS: "60000" })).toBe(DEFAULT_STREAM_CEILING_MS);
		expect(DEFAULT_STREAM_CEILING_MS).toBeGreaterThan(DEFAULT_TURN_TIMEOUT_MS);
		// Below the 30 min session watchdog, so the session cap stays the outer bound.
		expect(DEFAULT_STREAM_CEILING_MS).toBeLessThan(30 * 60 * 1000);
		expect(resolveStepCeilingMs({ EIGHT_TURN_TIMEOUT_MS: "5000" })).toBe(5000);
		expect(
			resolveStepCeilingMs({ EIGHT_STREAM_IDLE_MS: "60000", EIGHT_TURN_TIMEOUT_MS: "900000" }),
		).toBe(900_000);
	});
});

describe("EIGHT_STREAM_IDLE_MS is documented with the values the code uses", () => {
	const root = join(import.meta.dir, "..", "..");
	const docs = readFileSync(join(root, "docs", "VESSEL-ABILITIES.md"), "utf8");
	const para = docs.split("\n").find((l) => l.startsWith("`EIGHT_STREAM_IDLE_MS`")) ?? "";

	it("has its own paragraph right after the EIGHT_TURN_TIMEOUT_MS one", () => {
		expect(para).not.toBe("");
		const turnIdx = docs.indexOf("`EIGHT_TURN_TIMEOUT_MS` bounds");
		const idleIdx = docs.indexOf(para);
		expect(turnIdx).toBeGreaterThan(-1);
		expect(idleIdx).toBeGreaterThan(turnIdx);
		expect(
			docs
				.slice(turnIdx, idleIdx)
				.split("\n")
				.filter((l) => l.trim()).length,
		).toBe(1);
	});

	it("states on by default with the default gap, the off switch, the floor, the ceiling, the caps and the prefill warning", () => {
		expect(para).toContain(`on by default at \`${DEFAULT_STREAM_IDLE_MS}\``);
		expect(para).toContain(`${DEFAULT_STREAM_IDLE_MS / 60_000} minutes`);
		expect(para).toContain("Set `0` (or `off`) to turn the gap off");
		expect(para).toContain("reasoning tokens included");
		expect(para).toContain(`${resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "1" })} ms floor`);
		expect(para).toContain(`\`${DEFAULT_STREAM_CEILING_MS}\``);
		expect(para).toContain(`${DEFAULT_STREAM_CEILING_MS / 60_000} minutes`);
		expect(para).toContain("unless `EIGHT_TURN_TIMEOUT_MS` is set");
		expect(para).toContain("`max_tokens`");
		expect(para).toContain("30-minute session watchdog");
		expect(para).toContain("prefill");
	});

	it("has a CHANGELOG entry", () => {
		// The entry starts under [Unreleased] and moves into a version section at release (#3658),
		// so look for it in any section, not only under [Unreleased].
		const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		const heading = log.match(/^### .*\(#3553\)$/m);
		expect(heading).not.toBeNull();
		const bodyStart = (heading?.index ?? 0) + (heading?.[0].length ?? 0);
		const next = log.slice(bodyStart).search(/^##+ /m);
		const entry = next === -1 ? log.slice(bodyStart) : log.slice(bodyStart, bodyStart + next);
		expect(entry).toContain("`EIGHT_STREAM_IDLE_MS`");
	});
});

describe("modelFetch idleMs", () => {
	it("a body that keeps dripping finishes even when it outlasts several idle gaps", async () => {
		// 10 chunks, 120 ms apart (~1.1 s total) against a 400 ms idle gap.
		const started = Date.now();
		const res = await modelFetch(
			`${base}/x?mode=plain&gap=120`,
			{ method: "POST" },
			{
				timeoutMs: 10_000,
				idleMs: 400,
			},
		);
		const text = await res.text();
		expect(text).toBe(Array.from({ length: 10 }, (_, n) => `chunk${n};`).join(""));
		expect(Date.now() - started).toBeGreaterThan(400 * 2);
	});

	it("a body that goes silent after one chunk fails after one idle gap, not the ceiling", async () => {
		const started = Date.now();
		const res = await modelFetch(
			`${base}/x?mode=silent`,
			{ method: "POST" },
			{
				timeoutMs: 10_000,
				idleMs: 300,
				label: "fake/silent",
			},
		);
		const err = await res.text().catch((e: unknown) => e);
		const elapsed = Date.now() - started;
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect((err as TurnTimeoutError).timeoutMs).toBe(300);
		expect((err as Error).message).toContain("no output");
		expect(elapsed).toBeLessThan(3_000);
	});

	it("the wall-clock ceiling still bounds a body that never stops dripping", async () => {
		const res = await modelFetch(
			`${base}/x?mode=plain&gap=200`,
			{ method: "POST" },
			{
				timeoutMs: 700,
				idleMs: 1_000,
			},
		);
		const err = await res.text().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect((err as TurnTimeoutError).timeoutMs).toBe(700);
	});

	it("a caller abort mid-body stays an abort, not a timeout", async () => {
		const ac = new AbortController();
		const res = await modelFetch(
			`${base}/x?mode=silent`,
			{ method: "POST", signal: ac.signal },
			{
				timeoutMs: 10_000,
				idleMs: 5_000,
			},
		);
		setTimeout(() => ac.abort(), 100);
		const err = await res.text().catch((e: unknown) => e);
		expect(err).not.toBeInstanceOf(TurnTimeoutError);
		expect((err as Error).name).toBe("AbortError");
	});
});

describe("buildTextToolCall with a stream idle gap (#3553)", () => {
	// Swap fetch for a stub that records the request body and answers with one
	// JSON document, as a runtime that ignores `stream: true` would.
	async function withJsonStub(
		run: () => Promise<void>,
	): Promise<Record<string, unknown> | undefined> {
		const realFetch = globalThis.fetch;
		let sent: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_i: unknown, init?: { body?: string }) => {
			sent = JSON.parse(init?.body ?? "{}");
			return Response.json({ choices: [{ message: { content: "ok" } }] });
		}) as unknown as typeof fetch;
		try {
			await run();
		} finally {
			globalThis.fetch = realFetch;
		}
		return sent;
	}

	it("default (env unset) streams, and a JSON reply to a streamed request is still read (#3657)", async () => {
		const prev = process.env.EIGHT_STREAM_IDLE_MS;
		delete process.env.EIGHT_STREAM_IDLE_MS;
		try {
			const sent = await withJsonStub(async () => {
				const call = buildTextToolCall({ provider: "ollama", model: "m", timeoutMs: 5_000 });
				expect(await call([{ role: "user", content: "hi" }])).toBe("ok");
			});
			expect(sent?.stream).toBe(true);
			expect(sent?.stream_options).toEqual({ include_usage: true });
		} finally {
			if (prev !== undefined) process.env.EIGHT_STREAM_IDLE_MS = prev;
		}
	});

	it("EIGHT_STREAM_IDLE_MS=0 turns the gap off and sends stream: false", async () => {
		const prev = process.env.EIGHT_STREAM_IDLE_MS;
		process.env.EIGHT_STREAM_IDLE_MS = "0";
		try {
			const sent = await withJsonStub(async () => {
				const call = buildTextToolCall({ provider: "ollama", model: "m", timeoutMs: 5_000 });
				expect(await call([{ role: "user", content: "hi" }])).toBe("ok");
			});
			expect(sent?.stream).toBe(false);
			expect(sent?.stream_options).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.EIGHT_STREAM_IDLE_MS;
			else process.env.EIGHT_STREAM_IDLE_MS = prev;
		}
	});

	it("streams, reassembles content and split tool-call deltas, and reports real usage", async () => {
		bodies.length = 0;
		const seen: TextToolUsage[] = [];
		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			// Each chunk 150 ms apart (~1 s total) against a 400 ms idle gap and a
			// 10 s ceiling: the step outlasts two idle gaps and still finishes.
			endpoint: `${base}/v1/chat/completions?mode=chat&gap=150`,
			timeoutMs: 10_000,
			idleMs: 400,
			onUsage: (u) => seen.push(u),
		});
		const out = await call([{ role: "user", content: "read the readme" }]);
		expect(out).toEqual({
			content: "Reading the README.",
			toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }],
		});
		expect(seen).toEqual([{ promptTokens: 30, completionTokens: 12, totalTokens: 42 }]);
		const sent = bodies.find((b) => b.path === "/v1/chat/completions")?.body;
		expect(sent?.stream).toBe(true);
		expect(sent?.stream_options).toEqual({ include_usage: true });
		// The output cap is still sent (#3074).
		expect(typeof sent?.max_tokens).toBe("number");
	});

	it("a stream that goes silent fails the step with TurnTimeoutError after the idle gap", async () => {
		const started = Date.now();
		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			endpoint: `${base}/v1/chat/completions?mode=chat-silent`,
			timeoutMs: 10_000,
			idleMs: 300,
		});
		const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("a streamed reply cut off by the output cap still fails loudly (#3074)", async () => {
		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			endpoint: `${base}/v1/chat/completions?mode=chat-length&gap=10`,
			timeoutMs: 10_000,
			idleMs: 400,
			maxTokens: 64,
		});
		const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("64-token output cap");
	});
});

describe("buildTextToolCall raw recovery path streams too (#3553)", () => {
	it("reassembles Ollama's streamed /api/generate reply after a swallowed streamed reply", async () => {
		const seenPaths: Array<{ path: string; stream: unknown }> = [];
		const raw = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			async fetch(req) {
				const path = new URL(req.url).pathname;
				const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
				seenPaths.push({ path, stream: body.stream });
				if (path === "/api/show") return Response.json({ modelfile: "FROM x\nRENDERER qwen3.5\n" });
				if (path === "/v1/chat/completions") {
					// Ollama's parser ate the reply: no content, but real generated tokens.
					return new Response(
						drip(
							[
								sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
								sse({
									choices: [],
									usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
								}),
								"data: [DONE]\n\n",
							],
							10,
						),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				if (path === "/api/generate") {
					const lines = [
						{ response: "<think>hm</think>", done: false },
						{ response: "The answer", done: false },
						{ response: " is 4.", done: false },
						{ response: "", done: true, done_reason: "stop", prompt_eval_count: 9, eval_count: 6 },
					].map((o) => `${JSON.stringify(o)}\n`);
					return new Response(drip(lines, 120));
				}
				return new Response("nope", { status: 404 });
			},
		});
		try {
			const seen: TextToolUsage[] = [];
			const call = buildTextToolCall({
				provider: "ollama",
				model: "m",
				endpoint: `http://127.0.0.1:${raw.port}/v1/chat/completions`,
				timeoutMs: 10_000,
				idleMs: 300,
				onUsage: (u) => seen.push(u),
			});
			expect(await call([{ role: "user", content: "2+2?" }])).toBe("The answer is 4.");
			expect(seen).toEqual([
				{ promptTokens: 9, completionTokens: 5, totalTokens: 14 },
				{ promptTokens: 9, completionTokens: 6, totalTokens: 15 },
			]);
			expect(seenPaths.find((p) => p.path === "/api/generate")?.stream).toBe(true);
		} finally {
			raw.stop(true);
		}
	});
});

// A fake Ollama for the recovery tests: the chat stream and the raw generate
// stream are whatever the test hands in, /api/show reports a Qwen renderer so
// the raw path is available.
function fakeOllama(chat: () => string[], generate: () => string[]) {
	const seen: string[] = [];
	const srv = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			await req.text().catch(() => "");
			seen.push(path);
			if (path === "/api/show") return Response.json({ modelfile: "FROM x\nRENDERER qwen3.5\n" });
			if (path === "/v1/chat/completions") {
				return new Response(drip(chat(), 5), { headers: { "Content-Type": "text/event-stream" } });
			}
			if (path === "/api/generate") return new Response(drip(generate(), 5));
			return new Response("nope", { status: 404 });
		},
	});
	return { srv, seen, endpoint: `http://127.0.0.1:${srv.port}/v1/chat/completions` };
}

const ndjson = (objs: unknown[]) => objs.map((o) => `${JSON.stringify(o)}\n`);
const SWALLOWED_CHAT = () => [
	sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
	sse({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }),
	"data: [DONE]\n\n",
];
const GOOD_GENERATE = () =>
	ndjson([
		{ response: "<think>hm</think>", done: false },
		{ response: "The answer is 4.", done: false },
		{ response: "", done: true, done_reason: "stop", prompt_eval_count: 9, eval_count: 6 },
	]);

describe("streamed failures are failures, not empty successes (#3553 review F1)", () => {
	it("an in-band error frame on Ollama's chat stream still reaches the raw parser-failure recovery", async () => {
		// Ollama writes an error that happens after the first bytes as a frame on
		// a 200 stream. Non-streamed, the same failure is a parser 500.
		const f = fakeOllama(
			() => [
				sse({ choices: [{ index: 0, delta: { content: "" } }] }),
				sse({ error: { message: "XML syntax error on line 1", type: "api_error" } }),
				"data: [DONE]\n\n",
			],
			GOOD_GENERATE,
		);
		try {
			const call = buildTextToolCall({
				provider: "ollama",
				model: "m",
				endpoint: f.endpoint,
				timeoutMs: 10_000,
				idleMs: 400,
			});
			expect(await call([{ role: "user", content: "2+2?" }])).toBe("The answer is 4.");
			expect(f.seen).toContain("/api/generate");
		} finally {
			f.srv.stop(true);
		}
	});

	it("an in-band error frame that is not a parser failure fails the step loudly with its message", async () => {
		const f = fakeOllama(
			() => [
				sse({ choices: [{ index: 0, delta: { content: "half an ans" } }] }),
				sse({ error: { message: "model runner has unexpectedly stopped" } }),
			],
			GOOD_GENERATE,
		);
		try {
			const call = buildTextToolCall({
				provider: "lmstudio",
				model: "m",
				endpoint: f.endpoint,
				timeoutMs: 10_000,
				idleMs: 400,
			});
			const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("model runner has unexpectedly stopped");
			expect(f.seen).not.toContain("/api/generate");
		} finally {
			f.srv.stop(true);
		}
	});

	it("a chat stream that closes with neither [DONE] nor a finish_reason fails instead of returning the fragment", async () => {
		const f = fakeOllama(
			() => [
				sse({ choices: [{ index: 0, delta: { content: "Partial ans" } }] }),
				sse({ choices: [{ index: 0, delta: { content: "wer" } }] }),
			],
			GOOD_GENERATE,
		);
		try {
			const call = buildTextToolCall({
				provider: "lmstudio",
				model: "m",
				endpoint: f.endpoint,
				timeoutMs: 10_000,
				idleMs: 400,
			});
			const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("stream ended before");
		} finally {
			f.srv.stop(true);
		}
	});

	it("a chat stream that ends after a finish_reason but before [DONE] is still complete", async () => {
		const f = fakeOllama(
			() => [
				sse({ choices: [{ index: 0, delta: { content: "Done." } }] }),
				sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			],
			GOOD_GENERATE,
		);
		try {
			const call = buildTextToolCall({
				provider: "lmstudio",
				model: "m",
				endpoint: f.endpoint,
				timeoutMs: 10_000,
				idleMs: 400,
			});
			expect(await call([{ role: "user", content: "hi" }])).toBe("Done.");
		} finally {
			f.srv.stop(true);
		}
	});

	it("an error frame on the raw generate stream is reported with its message, not as 'no answer'", async () => {
		const f = fakeOllama(SWALLOWED_CHAT, () =>
			ndjson([
				{ response: "<think>", done: false },
				{ error: "llama runner process has terminated" },
			]),
		);
		try {
			const call = buildTextToolCall({
				provider: "ollama",
				model: "m",
				endpoint: f.endpoint,
				timeoutMs: 10_000,
				idleMs: 400,
			});
			const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("llama runner process has terminated");
		} finally {
			f.srv.stop(true);
		}
	});

	it("a raw generate stream with no final done:true line fails instead of returning the fragment", async () => {
		const f = fakeOllama(SWALLOWED_CHAT, () =>
			ndjson([
				{ response: "<think>hm</think>", done: false },
				{ response: "The answ", done: false },
			]),
		);
		try {
			const call = buildTextToolCall({
				provider: "ollama",
				model: "m",
				endpoint: f.endpoint,
				timeoutMs: 10_000,
				idleMs: 400,
			});
			const err = await call([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain("stream ended before");
		} finally {
			f.srv.stop(true);
		}
	});
});

describe("streamed tool-call index is bounded (#3553 review F2)", () => {
	const streamOf = (index: unknown) =>
		new Response(
			[
				sse({
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{ index, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' } },
								],
							},
						},
					],
				}),
				sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
				"data: [DONE]\n\n",
			].join(""),
		);

	it("a huge index neither blocks the event loop nor drops the call", async () => {
		const started = Date.now();
		const out = await readStreamedChatCompletion(streamOf(1e9));
		expect(Date.now() - started).toBeLessThan(500);
		expect(out.choices[0].message.tool_calls).toHaveLength(1);
		expect(
			(out.choices[0].message.tool_calls?.[0] as { function: { name: string } }).function.name,
		).toBe("read_file");
	});

	it("a negative or fractional index does not silently drop the call", async () => {
		for (const bad of [-1, 0.5]) {
			const out = await readStreamedChatCompletion(streamOf(bad));
			expect(out.choices[0].message.tool_calls).toHaveLength(1);
		}
	});

	it("calls are emitted in index order whatever order their deltas arrive in", async () => {
		const res = new Response(
			[
				sse({
					choices: [
						{
							index: 0,
							delta: { tool_calls: [{ index: 1, function: { name: "b", arguments: "{}" } }] },
						},
					],
				}),
				sse({
					choices: [
						{
							index: 0,
							delta: { tool_calls: [{ index: 0, function: { name: "a", arguments: "{}" } }] },
						},
					],
				}),
				"data: [DONE]\n\n",
			].join(""),
		);
		const out = await readStreamedChatCompletion(res);
		const names = (out.choices[0].message.tool_calls as Array<{ function: { name: string } }>).map(
			(c) => c.function.name,
		);
		expect(names).toEqual(["a", "b"]);
	});
});
