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
	MAX_TIMER_MS,
	type ProgressWatch,
	TurnTimeoutError,
	resolveRequestTimeoutMs,
	resolveStallMs,
	resolveStreamIdleMs,
	resolveTurnTimeoutMs,
	withProgressTimeout,
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
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "0" })).toBe(DEFAULT_TURN_TIMEOUT_MS);
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "-1" })).toBe(DEFAULT_TURN_TIMEOUT_MS);
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "abc" })).toBe(DEFAULT_TURN_TIMEOUT_MS);
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
			withTurnTimeout(
				neverSettles,
				50,
				() => {
					aborted = true;
				},
				"fake/never",
			),
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
		const out = await withTurnTimeout(
			async () => "fast",
			30,
			() => {
				firedAfterSuccess = true;
			},
		);
		expect(out).toBe("fast");
		await new Promise((r) => setTimeout(r, 60));
		expect(firedAfterSuccess).toBe(false);
	});
});

describe("timer clamp (#3671)", () => {
	it("MAX_TIMER_MS is the setTimeout limit", () => {
		expect(MAX_TIMER_MS).toBe(2_147_483_647);
	});

	for (const v of ["1e12", "99999999999", "2147483648"]) {
		it(`clamps EIGHT_TURN_TIMEOUT_MS=${v}`, () => {
			expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: v })).toBe(2_147_483_647);
		});
		it(`clamps EIGHT_STREAM_IDLE_MS=${v}`, () => {
			expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: v })).toBe(2_147_483_647);
		});
	}

	it("leaves in-range values alone", () => {
		expect(resolveTurnTimeoutMs({ EIGHT_TURN_TIMEOUT_MS: "2147483647" })).toBe(2_147_483_647);
		expect(resolveStreamIdleMs({ EIGHT_STREAM_IDLE_MS: "60000" })).toBe(60_000);
	});
});

// #4727: a stalled request says it is waiting, then gives up after a bound.
describe("withProgressTimeout stall notice and request timeout (#4727)", () => {
	const mk = () => {
		let t = 0;
		return {
			now: () => t,
			advance: (ms: number) => {
				t += ms;
			},
		};
	};

	it("fires the stall notice at N seconds on a fake clock, then every 15 s", async () => {
		const clock = mk();
		const seen: Array<number | null> = [];
		const p = withProgressTimeout(() => new Promise<never>(() => {}), {
			idleMs: null,
			ceilingMs: 10_000_000,
			requestMs: 300_000,
			stallMs: 30,
			onStall: (s) => seen.push(s),
			label: "minimax/m3",
			now: () => clock.now(),
		});
		p.catch(() => {});
		clock.advance(30_000);
		await new Promise((r) => setTimeout(r, 45));
		expect(seen.length).toBe(1);
		expect(seen[0]).toBe(30);
	});

	it("hard request timeout aborts and names the provider and elapsed time", async () => {
		let aborted = false;
		await expect(
			withProgressTimeout(() => new Promise<never>(() => {}), {
				idleMs: null,
				ceilingMs: 10_000_000,
				requestMs: 40,
				onTimeout: () => {
					aborted = true;
				},
				label: "minimax/m3",
			}),
		).rejects.toThrow(/No reply from minimax\/m3 after \d+s; the request was stopped/);
		expect(aborted).toBe(true);
	});

	it("progress resets the stall clock and clears the notice", async () => {
		const seen: Array<number | null> = [];
		let watch!: ProgressWatch;
		const p = withProgressTimeout(
			(w) => {
				watch = w;
				return new Promise<string>((res) => setTimeout(() => res("ok"), 120));
			},
			{
				idleMs: null,
				ceilingMs: 10_000,
				requestMs: 100,
				stallMs: 30,
				onStall: (s) => seen.push(s),
			},
		);
		await new Promise((r) => setTimeout(r, 50));
		expect(seen.length).toBe(1);
		watch.touch();
		expect(seen[1]).toBeNull();
		await new Promise((r) => setTimeout(r, 60));
		watch.touch();
		expect(await p).toBe("ok");
	});

	it("env overrides are respected, bad values fall back", () => {
		expect(resolveStallMs({})).toBe(45_000);
		expect(resolveStallMs({ EIGHT_STALL_SECONDS: "10" })).toBe(10_000);
		expect(resolveStallMs({ EIGHT_STALL_SECONDS: "x" })).toBe(45_000);
		expect(resolveRequestTimeoutMs({})).toBe(300_000);
		expect(resolveRequestTimeoutMs({ EIGHT_REQUEST_TIMEOUT_SECONDS: "90" })).toBe(90_000);
		expect(resolveRequestTimeoutMs({ EIGHT_REQUEST_TIMEOUT_SECONDS: "0" })).toBe(300_000);
	});

	it("emits null when the abort path settles and when a normal run ends after a notice", async () => {
		const aborted: Array<number | null> = [];
		await withProgressTimeout(() => new Promise<never>(() => {}), {
			idleMs: null,
			ceilingMs: 10_000,
			requestMs: 80,
			stallMs: 20,
			onStall: (x) => aborted.push(x),
			label: "verify-gate",
			displayLabel: "minimax/m3",
		}).catch((e) => expect(String(e.message)).toContain("minimax/m3"));
		expect(aborted.at(-1)).toBeNull();

		const done: Array<number | null> = [];
		await withProgressTimeout(() => new Promise<string>((r) => setTimeout(() => r("ok"), 60)), {
			idleMs: null,
			ceilingMs: 10_000,
			requestMs: 1000,
			stallMs: 20,
			onStall: (x) => done.push(x),
		});
		expect(done[0]).not.toBeNull();
		expect(done.at(-1)).toBeNull();
	});
});
