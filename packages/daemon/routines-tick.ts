/**
 * The daemon runs saved routines (#4926). Nothing did before: RoutineManager.tick had no caller.
 *
 * Scouts (read-only fetches the person listed and agreed to, written to a local file) run by
 * default. Ordinary routines start a headless chat with --yes, so they stay opt-in
 * (EIGHT_ROUTINES=1). One tick at a time: a tick still running is not started again.
 */

import type { RoutineRun } from "../cron/routines";

type Env = Record<string, string | undefined>;

interface Tickable {
	tick(now: Date, opts?: { kinds?: string[] }): Promise<RoutineRun[]>;
}

/** The routine kinds the daemon runs: scouts, plus ordinary routines when EIGHT_ROUTINES is on. undefined means all. */
export function routineKinds(env: Env = process.env): string[] | undefined {
	const v = env.EIGHT_ROUTINES;
	const on = !!v && v !== "0" && v.toLowerCase() !== "false";
	return on ? undefined : ["scout"];
}

let running = false;

export async function tickRoutines(
	opts: { now?: Date; env?: Env; manager?: Tickable } = {},
): Promise<void> {
	if (running) return;
	running = true;
	try {
		const manager = opts.manager ?? (await import("../cron/routines")).getRoutineManager();
		await manager.tick(opts.now ?? new Date(), { kinds: routineKinds(opts.env) });
	} catch (err) {
		console.error("[cron] routines tick error:", err);
	} finally {
		running = false;
	}
}
