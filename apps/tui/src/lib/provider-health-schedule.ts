/**
 * When the status bar's provider health probe runs (#4904).
 *
 * It used to run every 8 s for as long as the TUI was open, so an idle
 * session on a phone hit the local model server's health URL about 37 times in 5 minutes and
 * kept the CPU awake. Now it probes once at start, then waits longer each
 * time. A failed turn or a model choice asks for an immediate probe through
 * `probeNow`, which also starts the schedule over.
 */

/** Wait before probe 2, 3, 4...; the last entry repeats. Idle 5 minutes = 2 probes (t=0 and t=150 s). */
export const PROBE_BACKOFF_MS: readonly number[] = [
	150_000, 300_000, 600_000, 1_200_000, 1_800_000,
];

export function nextProbeDelayMs(probesSoFar: number): number {
	const i = Math.min(Math.max(probesSoFar - 1, 0), PROBE_BACKOFF_MS.length - 1);
	return PROBE_BACKOFF_MS[i];
}

export interface ProbeTimers {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
}

const realTimers: ProbeTimers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Runs `probe` now, then on the backoff schedule. Returns a stop function. */
export function startProviderHealthPolling(
	probe: () => Promise<void>,
	timers: ProbeTimers = realTimers,
): () => void {
	let stopped = false;
	let count = 0;
	let handle: unknown;
	const run = async () => {
		count += 1;
		try {
			await probe();
		} catch {
			// best-effort: a failed probe still backs off
		}
		if (!stopped) handle = timers.setTimeout(run, nextProbeDelayMs(count));
	};
	void run();
	return () => {
		stopped = true;
		if (handle !== undefined) timers.clearTimeout(handle);
	};
}
