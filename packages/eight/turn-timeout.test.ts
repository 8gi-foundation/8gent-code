/**
 * Tests for the per-attempt turn timeout guard.
 *
 * These prove the core termination guarantee that fixes the daemon turn hang:
 * an attempt that NEVER resolves still settles (with an error) within the
 * configured bound, and the abort hook fires so the underlying request is
 * torn down.
 */

import { describe, expect, it } from "bun:test";
import {
	DEFAULT_TURN_TIMEOUT_MS,
	TurnTimeoutError,
	resolveTurnTimeoutMs,
	withTurnTimeout,
} from "./turn-timeout";

describe("resolveTurnTimeoutMs", () => {
	it("pins the default at 5 min (local-first headroom)", () => {
		// Pin the literal so an accidental change to the constant trips a test.
		// 5 min gives slow-but-alive local models room while still defeating the
		// 30-min session-watchdog hang.
		expect(DEFAULT_TURN_TIMEOUT_MS).toBe(300_000);
	});

	it("defaults when env is unset", () => {
		expect(resolveTurnTimeoutMs({})).toBe(DEFAULT_TURN_TIMEOUT_MS);
	});

	it("honors a valid override", () => {
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "5000" })).toBe(5000);
	});

	it("falls back to default on zero / negative / non-numeric (never unbounded)", () => {
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "0" })).toBe(
			DEFAULT_TURN_TIMEOUT_MS,
		);
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "-1" })).toBe(
			DEFAULT_TURN_TIMEOUT_MS,
		);
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "abc" })).toBe(
			DEFAULT_TURN_TIMEOUT_MS,
		);
	});

	it("clamps below the floor", () => {
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "10" })).toBe(1000);
	});
});

describe("withTurnTimeout", () => {
	it("resolves when run settles before the deadline", async () => {
		const result = await withTurnTimeout(async () => "ok", 1000);
		expect(result).toBe("ok");
	});

	it("propagates run() rejection unchanged (real provider error path)", async () => {
		const err = new Error("Bad Request: invalid model");
		await expect(
			withTurnTimeout(async () => {
				throw err;
			}, 1000),
		).rejects.toBe(err);
	});

	it("rejects with TurnTimeoutError when run() NEVER resolves (the hang)", async () => {
		const start = Date.now();
		// A promise that never settles - models an unreachable / stalled provider.
		const neverSettles = () => new Promise<string>(() => {});
		let aborted = false;

		await expect(
			withTurnTimeout(neverSettles, 50, () => {
				aborted = true;
			}, "fake/never"),
		).rejects.toBeInstanceOf(TurnTimeoutError);

		const elapsed = Date.now() - start;
		// Settled, and well within a small multiple of the bound (not 30 min).
		expect(elapsed).toBeLessThan(1000);
		// Abort hook fired so the underlying request gets torn down.
		expect(aborted).toBe(true);
	});

	it("clears its timer when run wins (no dangling handle)", async () => {
		// If the timer were not cleared, an onTimeout side effect would still
		// fire after success. Assert it does not.
		let firedAfterSuccess = false;
		const out = await withTurnTimeout(async () => "fast", 30, () => {
			firedAfterSuccess = true;
		});
		expect(out).toBe("fast");
		await new Promise((r) => setTimeout(r, 60));
		expect(firedAfterSuccess).toBe(false);
	});
});
