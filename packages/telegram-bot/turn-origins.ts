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
 * Two modes. A daemon that advertises the `turn-origin` capability tags every turn-output
 * event with the channel that started the turn (`origin`): the bridge then delivers only
 * events whose origin is its own, and drops the rest, untagged ones included. That holds
 * across a reconnect in the middle of someone else's turn. A daemon that does not tag falls
 * back to the queue below, which fails open to today's behaviour: nothing queued, every
 * event is the bridge's.
 */

/** Events that are a turn's output, and so carry an origin from a tagging daemon. */
const TURN_OUTPUT = new Set([
	"tool:start",
	"tool:result",
	"agent:thinking",
	"agent:stream",
	"agent:error",
]);

export type TurnOrigin = "own" | "other";

export class TurnOrigins {
	private queue: TurnOrigin[] = [];
	/** Finals dropped for another surface whose session:end has not arrived yet. */
	private pendingEnds = 0;
	/** The daemon tags events with their origin (it advertised `turn-origin`). */
	private tagged = false;

	/** Call with the `capabilities` of session:created and session:resumed. */
	setCapabilities(capabilities: unknown): void {
		this.tagged = Array.isArray(capabilities) && capabilities.includes("turn-origin");
	}

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
		const p = (payload ?? {}) as {
			channel?: unknown;
			final?: unknown;
			origin?: unknown;
			reason?: unknown;
		};
		if (this.tagged) {
			if (event === "user:message") return false;
			const turnOutput =
				TURN_OUTPUT.has(event) || (event === "session:end" && p.reason === "turn-complete");
			return turnOutput ? p.origin === ownChannel : true;
		}
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
