/**
 * Pilot break 14: every spinner owned its own timer, so two rows repainted
 * about 12 times a second (6 MB in ten idle minutes). One shared clock means
 * one timer however many spinners are on screen, and none when none are.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { FIGURE_EIGHT_INTERVAL_MS } from "../lib/figure-eight";
import {
	spinnerClockListeners,
	spinnerClockTick,
	subscribeSpinnerClock,
} from "../lib/spinner-clock";

const unsubs: Array<() => void> = [];
afterEach(() => {
	for (const u of unsubs.splice(0)) u();
});

describe("spinner clock", () => {
	test("is slow enough to cut repaints but still reads as motion", () => {
		expect(FIGURE_EIGHT_INTERVAL_MS).toBeGreaterThanOrEqual(120);
		expect(FIGURE_EIGHT_INTERVAL_MS).toBeLessThanOrEqual(150);
	});

	test("three spinners share one tick: every listener fires once per interval", async () => {
		let a = 0;
		let b = 0;
		let c = 0;
		unsubs.push(subscribeSpinnerClock(() => a++));
		unsubs.push(subscribeSpinnerClock(() => b++));
		unsubs.push(subscribeSpinnerClock(() => c++));
		const t0 = spinnerClockTick();
		await new Promise((r) => setTimeout(r, FIGURE_EIGHT_INTERVAL_MS * 3 + 60));
		const ticks = spinnerClockTick() - t0;
		expect(ticks).toBeGreaterThanOrEqual(2);
		expect(ticks).toBeLessThanOrEqual(4);
		expect(a).toBe(ticks);
		expect(b).toBe(ticks);
		expect(c).toBe(ticks);
	});

	test("stops ticking when the last spinner unsubscribes", async () => {
		const off = subscribeSpinnerClock(() => {});
		expect(spinnerClockListeners()).toBe(1);
		off();
		expect(spinnerClockListeners()).toBe(0);
		const t0 = spinnerClockTick();
		await new Promise((r) => setTimeout(r, FIGURE_EIGHT_INTERVAL_MS * 2));
		expect(spinnerClockTick()).toBe(t0);
	});
});
