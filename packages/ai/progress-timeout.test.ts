/**
 * #3657: a text-tool step is judged by progress, not wall time.
 *
 * The SIGI v1.0 baseline found a local thinking model that needs about ten
 * minutes of reasoning tokens before its first answer. The old policy stopped
 * the turn at EIGHT_TURN_TIMEOUT_MS = 300 s with no answer, while the same
 * model called directly answered. These tests run that story on an injected
 * clock: minutes of simulated time, milliseconds of real time, no sleeps.
 *
 *  1. A provider that streams slowly for longer than the old 300 s limit
 *     completes its turn.
 *  2. A provider that goes silent past the no-progress gap is stopped, and
 *     the message says which knob to turn.
 *  3. An explicit EIGHT_TURN_TIMEOUT_MS is still the hard ceiling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { describeLocalTurnFailure } from "../eight/local-turn-error";
import {
	DEFAULT_STREAM_CEILING_MS,
	DEFAULT_STREAM_IDLE_MS,
	DEFAULT_TURN_TIMEOUT_MS,
	TurnTimeoutError,
	resolveStepCeilingMs,
	resolveStreamIdleMs,
} from "../eight/turn-timeout";
import type { ModelFetchTimers } from "./model-fetch";
import { buildTextToolCall } from "./text-tool-endpoint";

const ENDPOINT = "http://127.0.0.1:1234/v1/chat/completions";
const enc = new TextEncoder();
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

/** Deterministic timers: nothing fires until the test advances the clock. */
class FakeClock implements ModelFetchTimers {
	now = 0;
	private seq = 0;
	private queue: Array<{ id: number; at: number; fn: () => void }> = [];

	setTimeout(fn: () => void, ms: number): unknown {
		const id = ++this.seq;
		this.queue.push({ id, at: this.now + ms, fn });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.queue = this.queue.filter((t) => t.id !== handle);
	}

	/** Move time forward, firing due timers in order and letting promises settle. */
	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		for (;;) {
			this.queue.sort((a, b) => a.at - b.at);
			const next = this.queue[0];
			if (!next || next.at > target) break;
			this.queue.shift();
			this.now = next.at;
			next.fn();
			await settle();
		}
		this.now = target;
		await settle();
	}
}

/** Let pending promise chains and stream pulls run; a 0 ms yield, not a sleep. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** A fake model endpoint whose stream the test feeds by hand. */
type FakeProvider = {
	requests: Array<Record<string, unknown>>;
	send: (frame: string) => void;
	end: () => void;
};

let realFetch: typeof fetch;
let provider: FakeProvider;

beforeEach(() => {
	realFetch = globalThis.fetch;
	const requests: Array<Record<string, unknown>> = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	const pending: string[] = [];
	let ended = false;
	const flush = () => {
		if (!controller) return;
		for (const frame of pending.splice(0)) controller.enqueue(enc.encode(frame));
		if (ended) controller.close();
	};
	provider = {
		requests,
		send: (frame) => {
			pending.push(frame);
			flush();
		},
		end: () => {
			ended = true;
			flush();
		},
	};
	globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
		requests.push(JSON.parse(init?.body ?? "{}"));
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				flush();
			},
		});
		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Resolve or reject into a value so the test can poll without hanging. */
function track<T>(p: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
	const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
	p.then(
		(v) => {
			state.settled = true;
			state.value = v;
		},
		(e) => {
			state.settled = true;
			state.error = e;
		},
	);
	return state;
}

describe("a thinking model that streams for longer than the old 300 s limit (#3657)", () => {
	it("completes its turn: reasoning deltas are progress, and the answer comes back", async () => {
		const clock = new FakeClock();
		const env = {};
		const idleMs = resolveStreamIdleMs(env);
		const ceilingMs = resolveStepCeilingMs(env);
		expect(idleMs).toBe(DEFAULT_STREAM_IDLE_MS);
		expect(ceilingMs).toBe(DEFAULT_STREAM_CEILING_MS);

		const call = buildTextToolCall({
			provider: "lmstudio",
			model: "thinker",
			endpoint: ENDPOINT,
			timeoutMs: ceilingMs,
			idleMs,
			timers: clock,
		});
		const turn = track(call([{ role: "user", content: "a hard reasoning task" }]));
		await settle();
		expect(provider.requests[0]?.stream).toBe(true);

		// Ten minutes of thinking: one reasoning delta a minute, never a visible
		// token. Each delta is under the 5 min gap; the total is twice the old limit.
		for (let minute = 1; minute <= 10; minute++) {
			await clock.advance(60_000);
			provider.send(
				sse({ choices: [{ index: 0, delta: { reasoning_content: `step ${minute}... ` } }] }),
			);
			await settle();
			expect(turn.settled).toBe(false);
		}
		expect(clock.now).toBeGreaterThan(DEFAULT_TURN_TIMEOUT_MS);

		// Then the answer.
		provider.send(
			sse({ choices: [{ index: 0, delta: { role: "assistant", content: "The answer is 42." } }] }),
		);
		provider.send(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		provider.send(
			sse({
				choices: [],
				usage: { prompt_tokens: 900, completion_tokens: 4200, total_tokens: 5100 },
			}),
		);
		provider.send("data: [DONE]\n\n");
		provider.end();
		await settle();

		expect(turn.settled).toBe(true);
		expect(turn.error).toBeUndefined();
		expect(turn.value).toBe("The answer is 42.");
		expect(clock.now).toBe(10 * 60_000);
	});
});

describe("a provider that goes silent (#3657)", () => {
	it("is stopped after one no-progress gap, not the ceiling, with a message that names EIGHT_STREAM_IDLE_MS", async () => {
		const clock = new FakeClock();
		const idleMs = resolveStreamIdleMs({}) as number;
		const ceilingMs = resolveStepCeilingMs({});
		const call = buildTextToolCall({
			provider: "lmstudio",
			model: "thinker",
			endpoint: ENDPOINT,
			timeoutMs: ceilingMs,
			idleMs,
			timers: clock,
		});
		const turn = track(call([{ role: "user", content: "hi" }]));
		await settle();

		// One reasoning delta after two minutes, then nothing.
		await clock.advance(120_000);
		provider.send(sse({ choices: [{ index: 0, delta: { reasoning_content: "hm" } }] }));
		await settle();
		expect(turn.settled).toBe(false);

		// Just short of the gap: still waiting.
		await clock.advance(idleMs - 1);
		expect(turn.settled).toBe(false);

		// The gap elapses: stopped, long before the 20 min ceiling.
		await clock.advance(1);
		expect(turn.settled).toBe(true);
		expect(clock.now).toBe(120_000 + idleMs);
		expect(clock.now).toBeLessThan(ceilingMs);
		expect(turn.error).toBeInstanceOf(TurnTimeoutError);
		const err = turn.error as TurnTimeoutError;
		expect(err.kind).toBe("idle");
		expect(err.timeoutMs).toBe(idleMs);

		const failure = describeLocalTurnFailure(err, { endpoint: ENDPOINT, timeoutMs: ceilingMs });
		expect(failure.kind).toBe("timeout");
		expect(failure.message).toContain(`sent nothing for ${idleMs / 1000} seconds`);
		expect(failure.message).toContain("EIGHT_STREAM_IDLE_MS");
		expect(failure.message).toContain("EIGHT_STREAM_IDLE_MS=0");
	});
});

describe("an explicit EIGHT_TURN_TIMEOUT_MS still applies (#3657)", () => {
	it("is the hard ceiling even while the model keeps writing", async () => {
		const clock = new FakeClock();
		const env = { EIGHT_TURN_TIMEOUT_MS: "5000" };
		const idleMs = resolveStreamIdleMs(env) as number;
		const ceilingMs = resolveStepCeilingMs(env);
		expect(ceilingMs).toBe(5_000);
		expect(idleMs).toBe(DEFAULT_STREAM_IDLE_MS);

		const call = buildTextToolCall({
			provider: "ollama",
			model: "m",
			endpoint: ENDPOINT,
			timeoutMs: ceilingMs,
			idleMs,
			timers: clock,
		});
		const turn = track(call([{ role: "user", content: "hi" }]));
		await settle();

		// A token every second: progress the whole way, yet the ceiling wins.
		for (let s = 1; s <= 4; s++) {
			await clock.advance(1_000);
			provider.send(sse({ choices: [{ index: 0, delta: { content: "word " } }] }));
			await settle();
			expect(turn.settled).toBe(false);
		}
		await clock.advance(1_000);
		expect(turn.settled).toBe(true);
		expect(clock.now).toBe(5_000);
		const err = turn.error as TurnTimeoutError;
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect(err.kind).toBe("ceiling");
		expect(err.timeoutMs).toBe(5_000);

		const failure = describeLocalTurnFailure(err, { endpoint: ENDPOINT, timeoutMs: ceilingMs });
		expect(failure.message).toContain("took longer than 5 seconds");
		expect(failure.message).toContain("EIGHT_TURN_TIMEOUT_MS");
	});
});
