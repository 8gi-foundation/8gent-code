/**
 * #3643: prompt prefill is not silence.
 *
 * A local runtime such as Ollama sends nothing - not even response headers -
 * until the model has read the whole prompt. On a long document that prefill
 * alone ran past the 5-minute stream idle gap, so the step died on its FIRST
 * call before a single token came back (SIGI baseline: 3 of 4 long-document
 * runs stopped at exactly 300 s). The idle gap now starts counting at the
 * first byte; until then a separate first-token budget applies, sized from the
 * prompt so a short prompt on a dead endpoint still fails over in one gap.
 *
 * Timings are scaled down to milliseconds against a local Bun server; no model
 * runs. The long prompt is synthetic text generated here.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	PREFILL_FLOOR_TOKENS_PER_S,
	TurnTimeoutError,
	resolveFirstTokenMs,
} from "../eight/turn-timeout";
import { modelFetch } from "./model-fetch";
import { buildTextToolCall } from "./text-tool-endpoint";

const enc = new TextEncoder();
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const CHAT = [
	sse({ choices: [{ index: 0, delta: { role: "assistant", content: "The answer " } }] }),
	sse({ choices: [{ index: 0, delta: { content: "is 42." } }] }),
	sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
	"data: [DONE]\n\n",
];

// Synthetic long document: about `tokens` tokens at 4 characters per token.
function longDocument(tokens: number): string {
	const line = "The quick brown fox jumps over the lazy dog near the river bank. ";
	return line.repeat(Math.ceil((tokens * 4) / line.length));
}

let server: ReturnType<typeof Bun.serve> | null = null;
let base = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const prefill = Number(url.searchParams.get("prefill") ?? "0");
			const mode = url.searchParams.get("mode") ?? "";
			if (req.method === "POST") await req.text();
			if (mode === "ollama") {
				// Ollama-like: nothing at all (no headers) until prefill is done,
				// then the reply streams quickly.
				await Bun.sleep(prefill);
				return new Response(
					new ReadableStream({
						start(c) {
							for (const part of CHAT) c.enqueue(enc.encode(part));
							c.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			if (mode === "headers-first") {
				// llama-server-like: headers at once, first body byte after prefill.
				let sent = false;
				return new Response(
					new ReadableStream({
						async pull(c) {
							if (sent) {
								c.close();
								return;
							}
							await Bun.sleep(prefill);
							for (const part of CHAT) c.enqueue(enc.encode(part));
							sent = true;
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}
			if (mode === "dead") {
				// Socket accepted, headers sent, body never arrives.
				return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("unknown mode", { status: 400 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
});

describe("resolveFirstTokenMs", () => {
	const idle = 300_000;
	const ceiling = 1_200_000;

	it("an empty prompt gets exactly the idle gap, a short one only seconds more", () => {
		expect(resolveFirstTokenMs({ idleMs: idle, promptChars: 0, ceilingMs: ceiling, env: {} })).toBe(idle);
		// 500 tokens at the floor rate: 10 s, so a dead endpoint still fails over in about one gap.
		expect(resolveFirstTokenMs({ idleMs: idle, promptChars: 2_000, ceilingMs: ceiling, env: {} })).toBe(
			idle + 10_000,
		);
	});

	it("a long prompt adds prefill time at the conservative floor rate", () => {
		// 30k tokens at the floor rate.
		const promptChars = 30_000 * 4;
		const prefillMs = Math.ceil((30_000 / PREFILL_FLOOR_TOKENS_PER_S) * 1000);
		const got = resolveFirstTokenMs({ idleMs: idle, promptChars, ceilingMs: 10 * ceiling, env: {} });
		expect(got).toBe(idle + prefillMs);
		expect(got).toBeGreaterThan(idle);
	});

	it("never exceeds the step ceiling, and never drops below the idle gap", () => {
		expect(
			resolveFirstTokenMs({ idleMs: idle, promptChars: 4_000_000, ceilingMs: ceiling, env: {} }),
		).toBe(ceiling);
		expect(
			resolveFirstTokenMs({ idleMs: idle, promptChars: 4_000_000, ceilingMs: 60_000, env: {} }),
		).toBe(idle);
	});

	it("EIGHT_FIRST_TOKEN_MS overrides the estimate, with the 1 s floor", () => {
		const env = { EIGHT_FIRST_TOKEN_MS: "900000" };
		expect(resolveFirstTokenMs({ idleMs: idle, promptChars: 10, ceilingMs: ceiling, env })).toBe(900_000);
		expect(
			resolveFirstTokenMs({ idleMs: idle, promptChars: 10, ceilingMs: ceiling, env: { EIGHT_FIRST_TOKEN_MS: "5" } }),
		).toBe(1_000);
		// A typo falls back to the estimate, never to "no budget".
		expect(
			resolveFirstTokenMs({ idleMs: idle, promptChars: 0, ceilingMs: ceiling, env: { EIGHT_FIRST_TOKEN_MS: "soon" } }),
		).toBe(idle);
	});
});

describe("modelFetch firstByteMs: prefill is not idle time", () => {
	it("old behaviour pinned: without a first-token budget a prefill longer than the idle gap is fatal", async () => {
		const res = modelFetch(
			`${base}/v1/chat/completions?mode=ollama&prefill=700`,
			{ method: "POST", body: "{}" },
			{ timeoutMs: 10_000, idleMs: 250, label: "fake/ollama" },
		);
		const err = await res.then((r) => r.text()).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
	});

	it("an Ollama-style silent prefill longer than the idle gap succeeds inside the first-token budget", async () => {
		const res = await modelFetch(
			`${base}/v1/chat/completions?mode=ollama&prefill=700`,
			{ method: "POST", body: "{}" },
			{ timeoutMs: 10_000, idleMs: 250, firstByteMs: 2_000 },
		);
		expect(await res.text()).toContain("is 42.");
	});

	it("headers first, body after a long prefill: the budget runs to the first BODY byte", async () => {
		const res = await modelFetch(
			`${base}/v1/chat/completions?mode=headers-first&prefill=700`,
			{ method: "POST", body: "{}" },
			{ timeoutMs: 10_000, idleMs: 250, firstByteMs: 2_000 },
		);
		expect(await res.text()).toContain("is 42.");
	});

	it("a dead endpoint still fails, at the first-token budget, with an error that says so", async () => {
		const started = Date.now();
		const err = await modelFetch(
			`${base}/v1/chat/completions?mode=dead`,
			{ method: "POST", body: "{}" },
			{ timeoutMs: 10_000, idleMs: 250, firstByteMs: 600, label: "fake/dead" },
		)
			.then((r) => r.text())
			.catch((e: unknown) => e);
		const elapsed = Date.now() - started;
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect((err as TurnTimeoutError).kind).toBe("idle");
		expect((err as TurnTimeoutError).timeoutMs).toBe(600);
		expect((err as Error).message).toContain("first output");
		expect(elapsed).toBeGreaterThanOrEqual(550);
		expect(elapsed).toBeLessThan(3_000);
	});
});

describe("buildTextToolCall sizes the first-token budget from the prompt", () => {
	// idle gap 250 ms, server prefill 700 ms. At the floor rate a 60k-token
	// prompt earns minutes of budget (capped by the 10 s ceiling here); a short
	// prompt earns only the idle gap and fails like a dead endpoint would.
	const call = () =>
		buildTextToolCall({
			provider: "ollama",
			model: "fake-27b",
			endpoint: `${base}/v1/chat/completions?mode=ollama&prefill=700`,
			idleMs: 250,
			timeoutMs: 10_000,
			maxTokens: 64,
		});

	it("a long synthetic document on the first call survives a prefill longer than the idle gap", async () => {
		const doc = longDocument(60_000);
		const out = await call()([
			{ role: "system", content: "You answer questions about documents." },
			{ role: "user", content: `${doc}\n\nWhat is the answer?` },
		]);
		expect(out).toBe("The answer is 42.");
	});

	it("a short prompt still gets only the idle gap", async () => {
		const err = await call()([{ role: "user", content: "hi" }]).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
	});
});

describe("the first-token budget is documented with the values the code uses", () => {
	it("VESSEL-ABILITIES names EIGHT_FIRST_TOKEN_MS and the floor rate, and no longer claims the gap covers prefill", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const docs = readFileSync(join(import.meta.dir, "..", "..", "docs", "VESSEL-ABILITIES.md"), "utf8");
		const para = docs.split("\n").find((l) => l.startsWith("`EIGHT_STREAM_IDLE_MS`")) ?? "";
		expect(para).toContain("`EIGHT_FIRST_TOKEN_MS`");
		expect(para).toContain(`${PREFILL_FLOOR_TOKENS_PER_S} tokens per second`);
		expect(para).not.toContain("covers the worst-case prefill");
	});
});
