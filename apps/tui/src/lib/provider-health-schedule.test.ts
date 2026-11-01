import { describe, expect, test } from "bun:test";
import {
	PROBE_BACKOFF_MS,
	type ProbeTimers,
	nextProbeDelayMs,
	startProviderHealthPolling,
} from "./provider-health-schedule.js";

/** A manual clock: time moves only when the test advances it. */
function fakeClock() {
	let now = 0;
	let seq = 0;
	const pending = new Map<number, { at: number; fn: () => void }>();
	const timers: ProbeTimers = {
		setTimeout: (fn, ms) => {
			const id = ++seq;
			pending.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimeout: (h) => void pending.delete(h as number),
	};
	const settle = async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	};
	const advance = async (ms: number) => {
		await settle();
		const end = now + ms;
		for (;;) {
			const due = [...pending.entries()]
				.filter(([, t]) => t.at <= end)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			pending.delete(due[0]);
			now = due[1].at;
			due[1].fn();
			await settle();
		}
		now = end;
	};
	return { timers, advance, now: () => now };
}

describe("provider health schedule (#4904)", () => {
	test("idle for 5 minutes: at most 2 availability calls", async () => {
		const clock = fakeClock();
		let calls = 0;
		const stop = startProviderHealthPolling(async () => void calls++, clock.timers);
		await clock.advance(5 * 60_000);
		stop();
		expect(calls).toBeLessThanOrEqual(2);
		expect(calls).toBe(2);
	});

	test("a failing probe backs off the same way and never speeds up", async () => {
		const clock = fakeClock();
		const at: number[] = [];
		const stop = startProviderHealthPolling(async () => {
			at.push(clock.now());
			throw new Error("down");
		}, clock.timers);
		for (let i = 0; i < 40; i++) {
			await clock.advance(60_000);
		}
		stop();
		expect(at.slice(0, 4)).toEqual([0, 150_000, 450_000, 1_050_000]);
		const gaps = at.slice(1).map((v, i) => v - at[i]);
		for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
	});

	test("the backoff schedule is pinned", () => {
		expect([...PROBE_BACKOFF_MS]).toEqual([150_000, 300_000, 600_000, 1_200_000, 1_800_000]);
		expect([1, 2, 3, 4, 5, 6, 50].map(nextProbeDelayMs)).toEqual([
			150_000, 300_000, 600_000, 1_200_000, 1_800_000, 1_800_000, 1_800_000,
		]);
	});

	test("stop cancels the next probe", async () => {
		const clock = fakeClock();
		let calls = 0;
		const stop = startProviderHealthPolling(async () => void calls++, clock.timers);
		await clock.advance(0);
		stop();
		await clock.advance(60 * 60_000);
		expect(calls).toBe(1);
	});
});
