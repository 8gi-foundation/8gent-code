/**
 * #3855: a native attempt is a multi-step tool loop. It must fail on silence
 * (idle gap) and on the outer turn budget (ceiling), never on total time while
 * steps and tools keep finishing. Times are scaled down; the policy is the same.
 */
import { describe, expect, it } from "bun:test";
import { TurnTimeoutError, withProgressTimeout } from "./turn-timeout";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withProgressTimeout (#3855)", () => {
	it("(a) an active loop longer than the idle gap, with steady progress, is not killed", async () => {
		const t0 = Date.now();
		const out = await withProgressTimeout(
			async (watch) => {
				// 8 steps x 60 ms = 480 ms total, idle gap only 150 ms.
				for (let i = 0; i < 8; i++) {
					await sleep(60);
					watch.touch();
				}
				return "done";
			},
			{ idleMs: 150, ceilingMs: 5_000, label: "t" },
		);
		expect(out).toBe("done");
		expect(Date.now() - t0).toBeGreaterThan(150);
	});

	it("(a2) a long-running tool does not trip the idle gap, and the gap re-arms after it", async () => {
		const out = await withProgressTimeout(
			async (watch) => {
				watch.hold();
				await sleep(400); // tool runs 2.6x the idle gap
				watch.release();
				await sleep(50);
				return "ok";
			},
			{ idleMs: 150, ceilingMs: 5_000 },
		);
		expect(out).toBe("ok");

		let aborted = false;
		const err = await withProgressTimeout(
			async (watch) => {
				watch.hold();
				watch.release();
				return new Promise<string>(() => {});
			},
			{ idleMs: 100, ceilingMs: 5_000, onTimeout: () => (aborted = true) },
		).catch((e) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect(err.kind).toBe("idle");
		expect(aborted).toBe(true);
	});

	it("(b) a provider that sends nothing past the idle gap is killed (fail closed)", async () => {
		let aborted = false;
		const t0 = Date.now();
		const err = await withProgressTimeout(() => new Promise<string>(() => {}), {
			idleMs: 100,
			ceilingMs: 5_000,
			onTimeout: () => (aborted = true),
			label: "hung",
		}).catch((e) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect(err.kind).toBe("idle");
		expect(err.timeoutMs).toBe(100);
		expect(err.message).toContain("hung");
		expect(aborted).toBe(true);
		expect(Date.now() - t0).toBeLessThan(1_000);
	});

	it("(b2) progress that stops is killed one gap after the last signal", async () => {
		const err = await withProgressTimeout(
			async (watch) => {
				for (let i = 0; i < 3; i++) {
					await sleep(40);
					watch.touch();
				}
				return new Promise<string>(() => {});
			},
			{ idleMs: 120, ceilingMs: 5_000 },
		).catch((e) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect(err.kind).toBe("idle");
	});

	it("(c) the outer turn budget still applies to a loop that keeps making progress", async () => {
		let aborted = false;
		const err = await withProgressTimeout(
			async (watch) => {
				for (;;) {
					await sleep(30);
					watch.touch();
				}
			},
			{ idleMs: 150, ceilingMs: 300, onTimeout: () => (aborted = true) },
		).catch((e) => e);
		expect(err).toBeInstanceOf(TurnTimeoutError);
		expect(err.kind).toBe("ceiling");
		expect(err.timeoutMs).toBe(300);
		expect(aborted).toBe(true);
	});

	it("(c2) the ceiling also bounds a held tool that never returns", async () => {
		const err = await withProgressTimeout(
			async (watch) => {
				watch.hold();
				return new Promise<string>(() => {});
			},
			{ idleMs: 100, ceilingMs: 250 },
		).catch((e) => e);
		expect(err.kind).toBe("ceiling");
	});

	it("idleMs null (EIGHT_STREAM_IDLE_MS=0) leaves only the ceiling", async () => {
		const err = await withProgressTimeout(() => new Promise<string>(() => {}), {
			idleMs: null,
			ceilingMs: 200,
		}).catch((e) => e);
		expect(err.kind).toBe("ceiling");
	});

	it("propagates a real run() rejection unchanged and clears timers", async () => {
		const boom = new Error("rate limit");
		let fired = false;
		await expect(
			withProgressTimeout(
				async () => {
					throw boom;
				},
				{ idleMs: 100, ceilingMs: 200, onTimeout: () => (fired = true) },
			),
		).rejects.toBe(boom);
		await sleep(300);
		expect(fired).toBe(false);
	});
});
