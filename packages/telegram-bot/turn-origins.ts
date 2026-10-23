/**
 * Whose turn is it? (#4834)
 *
 * The Telegram session can also be joined by the TUI. The daemon echoes every other
 * surface's prompt to the bridge as a `user:message` event with its channel, and runs
 * turns one at a time, so the order the bridge sees (its own prompts, and those echoes)
 * is the order the replies come back. This keeps that order and says, for each event,
 * whether it belongs to a turn the bridge started. Replies to anyone else's turn are
 * never posted to Telegram: a TUI turn must not land in whatever chat spoke last.
 *
 * Fails open to today's behaviour: with nothing queued, every event is the bridge's.
 */

export type TurnOrigin = "own" | "other";

export class TurnOrigins {
	private queue: TurnOrigin[] = [];
	/** Finals dropped for another surface whose session:end has not arrived yet. */
	private pendingEnds = 0;

	/** The bridge sent a prompt. */
	own(): void {
		this.queue.push("own");
	}

	/** Forget everything: a new session, or a reconnect. */
	reset(): void {
		this.queue = [];
		this.pendingEnds = 0;
	}

	/**
	 * Should this daemon event reach the Telegram side? `user:message` is bookkeeping and
	 * is never delivered. `ownChannel` is the channel the bridge itself prompts on.
	 */
	deliver(event: string, payload: unknown, ownChannel = "telegram"): boolean {
		const p = (payload ?? {}) as { channel?: unknown; final?: unknown };
		switch (event) {
			case "user:message":
				if (p.channel !== ownChannel) this.queue.push("other");
				return false;
			case "agent:stream":
				if (p.final !== true) return this.queue[0] !== "other";
				if (this.queue.shift() === "other") {
					this.pendingEnds++;
					return false;
				}
				return true;
			case "agent:error":
				return this.queue.shift() !== "other";
			case "session:end":
				if (this.pendingEnds > 0) {
					this.pendingEnds--;
					return false;
				}
				return true;
			case "tool:start":
			case "tool:result":
			case "agent:thinking":
				return this.queue[0] !== "other";
			default:
				return true;
		}
	}
}
