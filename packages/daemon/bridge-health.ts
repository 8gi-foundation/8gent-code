/**
 * Telegram bridge liveness, shared with the gateway's /health (#3708).
 *
 * The bridge runs in the daemon process, so a module-level record is enough:
 * the poll loop stamps it after every completed getUpdates and /health reads it.
 * `svc status eightgent` compares the age against a threshold to show a stall.
 */

let lastSuccessfulPollAt: number | null = null;
let registered = false;

/** Called when a bridge starts polling, so /health knows one exists. */
export function registerTelegramBridge(): void {
	registered = true;
}

export function recordTelegramPoll(now = Date.now()): void {
	registered = true;
	lastSuccessfulPollAt = now;
}

/** null when no bridge runs in this process. */
export function telegramBridgeHealth(now = Date.now()): {
	lastSuccessfulPoll: string | null;
	secondsSinceLastPoll: number | null;
} | null {
	if (!registered) return null;
	return {
		lastSuccessfulPoll: lastSuccessfulPollAt ? new Date(lastSuccessfulPollAt).toISOString() : null,
		secondsSinceLastPoll:
			lastSuccessfulPollAt === null ? null : Math.round((now - lastSuccessfulPollAt) / 1000),
	};
}

/** Test hook. */
export function resetTelegramBridgeHealth(): void {
	lastSuccessfulPollAt = null;
	registered = false;
}
