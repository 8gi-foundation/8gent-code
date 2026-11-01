/**
 * Behavior tests for packages/tools/error-recovery.ts.
 *
 * All timing goes through an injected sleep that records the requested
 * delays and resolves immediately, and jitter uses an injected random,
 * so the suite is deterministic and never waits on the wall clock.
 */

import { describe, expect, test } from "bun:test";
import {
	backoffDelay,
	chainStrategies,
	fallback,
	retry,
	retryAsync,
	withRecovery,
} from "../error-recovery";

/** Sleep double: records every requested delay, resolves immediately. */
function fakeSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
	const delays: number[] = [];
	return {
		delays,
		sleep: (ms: number) => {
			delays.push(ms);
			return Promise.resolve();
		},
	};
}

/** Async fn double that fails `failures` times, then returns `value`. */
function flaky<T>(failures: number, value: T) {
	let calls = 0;
	const fn = async () => {
		calls++;
		if (calls <= failures) throw new Error(`fail ${calls}`);
		return value;
	};
	return { fn, calls: () => calls };
}

describe("backoffDelay", () => {
	test("fixed backoff returns the base delay for every attempt", () => {
		const opts = { delayMs: 100, backoff: "fixed" as const };
		expect(backoffDelay(1, opts)).toBe(100);
		expect(backoffDelay(2, opts)).toBe(100);
		expect(backoffDelay(5, opts)).toBe(100);
	});

	test("exponential backoff doubles per attempt", () => {
		const opts = { delayMs: 100, backoff: "exponential" as const };
		expect(backoffDelay(1, opts)).toBe(100);
		expect(backoffDelay(2, opts)).toBe(200);
		expect(backoffDelay(3, opts)).toBe(400);
		expect(backoffDelay(4, opts)).toBe(800);
	});

	test("linear backoff grows by the base delay per attempt", () => {
		const opts = { delayMs: 100, backoff: "linear" as const };
		expect(backoffDelay(1, opts)).toBe(100);
		expect(backoffDelay(2, opts)).toBe(200);
		expect(backoffDelay(3, opts)).toBe(300);
	});

	test("maxDelayMs caps the computed delay", () => {
		const opts = { delayMs: 100, backoff: "exponential" as const, maxDelayMs: 250 };
		expect(backoffDelay(1, opts)).toBe(100);
		expect(backoffDelay(2, opts)).toBe(200);
		expect(backoffDelay(3, opts)).toBe(250);
		expect(backoffDelay(10, opts)).toBe(250);
	});

	test("zero or missing delayMs always yields 0", () => {
		expect(backoffDelay(3, {})).toBe(0);
		expect(backoffDelay(3, { delayMs: 0, backoff: "exponential" })).toBe(0);
	});

	test("jitter with random()=0 yields exactly half the delay (lower bound)", () => {
		const d = backoffDelay(1, { delayMs: 100, jitter: true, random: () => 0 });
		expect(d).toBe(50);
	});

	test("jitter with random()->1 approaches the full delay (upper bound)", () => {
		const d = backoffDelay(1, { delayMs: 100, jitter: true, random: () => 0.999999 });
		expect(d).toBeGreaterThan(99.99);
		expect(d).toBeLessThanOrEqual(100);
	});

	test("jitter stays within [delay/2, delay] across the random range", () => {
		for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
			const d = backoffDelay(3, {
				delayMs: 100,
				backoff: "exponential",
				jitter: true,
				random: () => r,
			});
			expect(d).toBeGreaterThanOrEqual(200);
			expect(d).toBeLessThanOrEqual(400);
		}
	});
});

describe("retryAsync", () => {
	test("returns immediately on first success without sleeping", async () => {
		const { delays, sleep } = fakeSleep();
		const { fn, calls } = flaky(0, "ok");
		const result = await retryAsync(fn, { attempts: 3, delayMs: 100, sleep });
		expect(result).toBe("ok");
		expect(calls()).toBe(1);
		expect(delays).toEqual([]);
	});

	test("retries until success and reports the attempt count", async () => {
		const { sleep } = fakeSleep();
		const { fn, calls } = flaky(2, "ok");
		const result = await retryAsync(fn, { attempts: 5, sleep });
		expect(result).toBe("ok");
		expect(calls()).toBe(3);
	});

	test("passes the 1-based attempt number to fn", async () => {
		const seen: number[] = [];
		await expect(
			retryAsync(
				(attempt) => {
					seen.push(attempt);
					throw new Error("nope");
				},
				{ attempts: 3, sleep: fakeSleep().sleep },
			),
		).rejects.toThrow("nope");
		expect(seen).toEqual([1, 2, 3]);
	});

	test("throws the last error after exhausting attempts", async () => {
		const { fn, calls } = flaky(99, "never");
		await expect(retryAsync(fn, { attempts: 4, sleep: fakeSleep().sleep })).rejects.toThrow(
			"fail 4",
		);
		expect(calls()).toBe(4);
	});

	test("attempts below 1 are clamped to a single attempt", async () => {
		const { fn, calls } = flaky(99, "never");
		await expect(retryAsync(fn, { attempts: 0, sleep: fakeSleep().sleep })).rejects.toThrow(
			"fail 1",
		);
		expect(calls()).toBe(1);
	});

	test("fixed backoff sleeps the base delay between attempts", async () => {
		const { delays, sleep } = fakeSleep();
		const { fn } = flaky(3, "ok");
		await retryAsync(fn, { attempts: 4, delayMs: 100, backoff: "fixed", sleep });
		expect(delays).toEqual([100, 100, 100]);
	});

	test("exponential backoff sleeps a doubling sequence", async () => {
		const { delays, sleep } = fakeSleep();
		const { fn } = flaky(3, "ok");
		await retryAsync(fn, { attempts: 4, delayMs: 100, backoff: "exponential", sleep });
		expect(delays).toEqual([100, 200, 400]);
	});

	test("linear backoff sleeps a linearly growing sequence", async () => {
		const { delays, sleep } = fakeSleep();
		const { fn } = flaky(3, "ok");
		await retryAsync(fn, { attempts: 4, delayMs: 100, backoff: "linear", sleep });
		expect(delays).toEqual([100, 200, 300]);
	});

	test("maxDelayMs caps the slept delays", async () => {
		const { delays, sleep } = fakeSleep();
		const { fn } = flaky(4, "ok");
		await retryAsync(fn, {
			attempts: 5,
			delayMs: 100,
			backoff: "exponential",
			maxDelayMs: 300,
			sleep,
		});
		expect(delays).toEqual([100, 200, 300, 300]);
	});

	test("jitter randomizes each delay within [delay/2, delay] using the injected random", async () => {
		const { delays, sleep } = fakeSleep();
		const randoms = [0, 0.5, 0.999999];
		let i = 0;
		const { fn } = flaky(3, "ok");
		await retryAsync(fn, {
			attempts: 4,
			delayMs: 100,
			backoff: "fixed",
			jitter: true,
			random: () => randoms[i++],
			sleep,
		});
		expect(delays[0]).toBe(50);
		expect(delays[1]).toBe(75);
		expect(delays[2]).toBeGreaterThan(99.99);
		expect(delays[2]).toBeLessThanOrEqual(100);
	});

	test("retryIf(false) short-circuits: no more attempts, no onRetry, no sleep", async () => {
		const { delays, sleep } = fakeSleep();
		const onRetry: number[] = [];
		const { fn, calls } = flaky(99, "never");
		await expect(
			retryAsync(fn, {
				attempts: 5,
				delayMs: 100,
				retryIf: () => false,
				onRetry: (attempt) => onRetry.push(attempt),
				sleep,
			}),
		).rejects.toThrow("fail 1");
		expect(calls()).toBe(1);
		expect(onRetry).toEqual([]);
		expect(delays).toEqual([]);
	});

	test("retryIf can stop mid-run once the error stops matching", async () => {
		let calls = 0;
		const fn = async () => {
			calls++;
			throw new Error(calls < 3 ? "transient" : "fatal");
		};
		await expect(
			retryAsync(fn, {
				attempts: 10,
				retryIf: (err) => err instanceof Error && err.message === "transient",
				sleep: fakeSleep().sleep,
			}),
		).rejects.toThrow("fatal");
		expect(calls).toBe(3);
	});

	test("onRetry receives the 1-based retry number and the causing error", async () => {
		const seen: Array<[number, string]> = [];
		const { fn } = flaky(2, "ok");
		await retryAsync(fn, {
			attempts: 5,
			onRetry: (attempt, err) => seen.push([attempt, (err as Error).message]),
			sleep: fakeSleep().sleep,
		});
		expect(seen).toEqual([
			[1, "fail 1"],
			[2, "fail 2"],
		]);
	});

	test("onRetry is not called after the final failed attempt", async () => {
		const onRetry: number[] = [];
		const { fn } = flaky(99, "never");
		await expect(
			retryAsync(fn, {
				attempts: 3,
				onRetry: (attempt) => onRetry.push(attempt),
				sleep: fakeSleep().sleep,
			}),
		).rejects.toThrow();
		expect(onRetry).toEqual([1, 2]);
	});

	test("supports synchronous fn return values", async () => {
		const result = await retryAsync(() => 42, { attempts: 1 });
		expect(result).toBe(42);
	});
});

describe("retry strategy via withRecovery", () => {
	test("recovers when a later attempt succeeds", async () => {
		const { fn, calls } = flaky(2, "recovered");
		const result = await withRecovery(fn, retry({ attempts: 3, sleep: fakeSleep().sleep }));
		expect(result).toBe("recovered");
		expect(calls()).toBe(3);
	});

	test("throws the last error when all attempts fail", async () => {
		const { fn, calls } = flaky(99, "never");
		await expect(
			withRecovery(fn, retry({ attempts: 3, sleep: fakeSleep().sleep })),
		).rejects.toThrow("fail 3");
		expect(calls()).toBe(3);
	});

	test("sleeps the exponential sequence through the injected sleep", async () => {
		const { delays, sleep } = fakeSleep();
		const { fn } = flaky(99, "never");
		await expect(
			withRecovery(fn, retry({ attempts: 4, delayMs: 100, backoff: "exponential", sleep })),
		).rejects.toThrow();
		expect(delays).toEqual([100, 200, 400]);
	});

	test("honors retryIf: a non-retryable error is rethrown without another attempt", async () => {
		const { fn, calls } = flaky(99, "never");
		await expect(
			withRecovery(
				fn,
				retry({
					attempts: 5,
					retryIf: () => false,
					sleep: fakeSleep().sleep,
				}),
			),
		).rejects.toThrow("fail 1");
		expect(calls()).toBe(1);
	});

	test("invokes onRetry before each retry with the previous error", async () => {
		const seen: Array<[number, string]> = [];
		const { fn } = flaky(2, "ok");
		await withRecovery(
			fn,
			retry({
				attempts: 3,
				onRetry: (attempt, err) => seen.push([attempt, (err as Error).message]),
				sleep: fakeSleep().sleep,
			}),
		);
		expect(seen).toEqual([
			[1, "fail 1"],
			[2, "fail 2"],
		]);
	});

	test("composes with fallback through chainStrategies", async () => {
		const { fn } = flaky(99, "never");
		const result = await withRecovery(
			fn,
			chainStrategies(
				retry({ attempts: 2, sleep: fakeSleep().sleep }),
				fallback(() => "fallback value"),
			),
		);
		expect(result).toBe("fallback value");
	});
});
