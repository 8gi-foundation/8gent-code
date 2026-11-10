/**
 * One clock for every working spinner (pilot break 14).
 *
 * Each FigureEight used to own a setInterval, so the NOW strip and the
 * Reasoning row repainted on separate timers: about 12 row writes a second,
 * 6 MB of terminal output in ten idle minutes. Here every spinner subscribes
 * to a single interval, so one tick is one render, and the interval is the
 * slowest pace that still reads as motion.
 *
 * Pure of Ink and React so the count of timers can be tested directly.
 */

import { FIGURE_EIGHT_INTERVAL_MS } from "./figure-eight.js";

type Listener = () => void;

const listeners = new Set<Listener>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Subscribe to the shared tick. The interval runs only while someone listens. */
export function subscribeSpinnerClock(listener: Listener): () => void {
	listeners.add(listener);
	if (timer === null) {
		timer = setInterval(() => {
			tick += 1;
			for (const l of [...listeners]) l();
		}, FIGURE_EIGHT_INTERVAL_MS);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
}

export function spinnerClockTick(): number {
	return tick;
}

/** Live subscriber count, for tests. */
export function spinnerClockListeners(): number {
	return listeners.size;
}
