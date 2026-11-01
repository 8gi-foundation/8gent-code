/**
 * Regression tests for the hidden 300 s model-step limit.
 *
 * Bun's fetch aborts any request on its own after 300 s ("TimeoutError: The
 * operation timed out.") unless the caller passes `timeout: false`. A slow
 * local model (Ollama logged 500 | 4m43s | POST /v1/chat/completions) was
 * killed at exactly 300 s no matter what EIGHT_TURN_TIMEOUT_MS said.
 *
 * modelFetch turns Bun's timer off and enforces OUR limit instead, so
 * EIGHT_TURN_TIMEOUT_MS is the single source of truth. The limit is injectable
 * so these tests run against a real local Bun server that answers after a
 * short delay, without waiting 300 s.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { TurnTimeoutError } from "../eight/turn-timeout";
import { modelFetch } from "./model-fetch";

const realFetch = globalThis.fetch;

let server: ReturnType<typeof Bun.serve> | null = null;
let base = "";

beforeAll(() => {
	// A local model endpoint that answers after ?delay=<ms>.
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 0,
		async fetch(req) {
			const delay = Number(new URL(req.url).searchParams.get("delay") ?? "0");
			await Bun.sleep(delay);
			return Response.json({ choices: [{ message: { content: `slept ${delay}` } }] });
		},
	});
	base = `http://127.0.0.1:${server.port}/v1/chat/completions`;
});

afterAll(() => {
	server?.stop(true);
});

afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env.EIGHT_TURN_TIMEOUT_MS;
});

describe("modelFetch", () => {
	it("turns off Bun's built-in 300 s fetch timeout (timeout: false)", async () => {
		let seen: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_input: unknown, init?: Record<string, unknown>) => {
			seen = init;
			return Response.json({});
		}) as unknown as typeof fetch;

		await modelFetch("http://127.0.0.1:1/x", { method: "POST" }, { timeoutMs: 5_000 });

		expect(seen).toBeDefined();
		expect(seen?.timeout).toBe(false);
		expect(seen?.method).toBe("POST");
		expect(seen?.signal).toBeInstanceOf(AbortSignal);
	});

	it("lets a slow model answer when it finishes inside the limit", async () => {
		const res = await modelFetch(`${base}?delay=400`, { method: "POST" }, { timeoutMs: 3_000 });
		expect(res.ok).toBe(true);
		const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
		expect(body.choices[0].message.content).toBe("slept 400");
	});

	it("stops the request at OUR limit with a TurnTimeoutError", async () => {
		const started = Date.now();
		let caught: unknown;
		try {
			await modelFetch(
				`${base}?delay=2000`,
				{ method: "POST" },
				{ timeoutMs: 150, label: "ollama/m" },
			);
		} catch (err) {
			caught = err;
		}
		const elapsed = Date.now() - started;

		expect(caught).toBeInstanceOf(TurnTimeoutError);
		expect((caught as TurnTimeoutError).timeoutMs).toBe(150);
		expect((caught as Error).message).toContain("ollama/m");
		// Bounded by our limit, not by the server's 2 s delay.
		expect(elapsed).toBeLessThan(1_500);
	});

	it("takes its default limit from EIGHT_TURN_TIMEOUT_MS", async () => {
		// 1000 ms is the floor resolveTurnTimeoutMs allows.
		process.env.EIGHT_TURN_TIMEOUT_MS = "1000";
		let caught: unknown;
		try {
			await modelFetch(`${base}?delay=2500`, { method: "POST" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TurnTimeoutError);
		expect((caught as TurnTimeoutError).timeoutMs).toBe(1_000);
	});

	it("a caller abort (ESC, circuit breaker) stays an abort, not a timeout", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		let caught: unknown;
		try {
			await modelFetch(
				`${base}?delay=2000`,
				{ method: "POST", signal: ac.signal },
				{ timeoutMs: 5_000 },
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(caught).not.toBeInstanceOf(TurnTimeoutError);
		expect((caught as Error).name).toBe("AbortError");
	});

	it("an unreachable endpoint rejects as a connection failure, not a timeout", async () => {
		// Port 1 on loopback is closed: ECONNREFUSED.
		let caught: unknown;
		try {
			await modelFetch(
				"http://127.0.0.1:1/v1/chat/completions",
				{ method: "POST" },
				{ timeoutMs: 5_000 },
			);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeDefined();
		expect(caught).not.toBeInstanceOf(TurnTimeoutError);
	});
});
