/**
 * Harness protocol: one session-shaped contract for driving any coding
 * harness (this repo's own loop, a shell, another CLI) the same way.
 *
 * Spec: docs/specs/HARNESS-PROTOCOL.md. Behind EIGHT_HARNESS_PROTOCOL=1,
 * which ships off. Sits beside the one-shot `Harness.run` in ../index.ts;
 * it does not replace it.
 */

/** Date-stamped revision of this contract. Bump on any breaking change. */
export const HARNESS_PROTOCOL_VERSION = "2026-11-12";

/** The flag. Anything but "1" leaves the protocol off. */
export const HARNESS_PROTOCOL_FLAG = "EIGHT_HARNESS_PROTOCOL";

export function harnessProtocolEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env[HARNESS_PROTOCOL_FLAG]?.trim() === "1";
}

/** What an adapter can do. Every field is always present: false means no. */
export interface HarnessCapabilities {
	/** Must equal HARNESS_PROTOCOL_VERSION for the revision the adapter was built to. */
	protocol: string;
	/** Must equal the adapter's `id`. */
	harness: string;
	/** text.delta events arrive while the turn runs, not all at the end. */
	streaming: boolean;
	/** A later turn in a session sees the earlier ones. */
	sessions: boolean;
	/** cancel() stops a running turn. */
	cancel: boolean;
	/** Turns one session may run at once. 1 means a second send is refused as busy. */
	maxConcurrentTurns: number;
	/** Nothing the turn sends leaves this device. */
	local: boolean;
}

export interface StartOptions {
	/** Working directory for every turn in the session. Defaults to process.cwd(). */
	cwd?: string;
	/** Extra environment for the harness process, merged over the parent's. */
	env?: Record<string, string>;
	/** Per-turn time limit in ms. A turn that hits it ends `incomplete`, reason "timeout". */
	turnTimeoutMs?: number;
}

export interface HarnessSession {
	id: string;
	harness: string;
	cwd: string;
}

export interface TurnInput {
	text: string;
}

/**
 * How a turn ended. A cancel is never `failed`: the person asked for the stop.
 * `incomplete` means it stopped short without an error (timeout, budget).
 */
export type TurnStatus = "completed" | "failed" | "cancelled" | "incomplete";

interface EventBase {
	/** 0 for turn.started, then +1 per event, no gaps. */
	seq: number;
	turnId: string;
}

export type HarnessEvent =
	| (EventBase & { type: "turn.started"; sessionId: string; harness: string })
	| (EventBase & { type: "text.delta"; text: string })
	| (EventBase & { type: "tool.started"; tool: string })
	| (EventBase & { type: "tool.finished"; tool: string; ok: boolean })
	| (EventBase & { type: "log"; text: string })
	| TurnEnded;

export interface TurnEnded extends EventBase {
	type: "turn.ended";
	status: TurnStatus;
	/** The whole answer: every text.delta of the turn, joined in seq order. */
	output: string;
	/** Present, and not empty, exactly when status is "failed". */
	error?: string;
	/** Why a turn ended incomplete, e.g. "timeout". */
	reason?: string;
	durationMs: number;
}

export interface HarnessTurn {
	id: string;
	sessionId: string;
	/** Every event of the turn from seq 0, however late the caller starts reading. */
	events(): AsyncIterable<HarnessEvent>;
	/** Resolves with the turn.ended event. Never rejects. */
	done: Promise<TurnEnded>;
}

export type HarnessErrorCode = "session_not_found" | "session_busy" | "empty_input";

/** Thrown synchronously by send() when a turn cannot begin. */
export class HarnessError extends Error {
	constructor(
		readonly code: HarnessErrorCode,
		message: string,
	) {
		super(message);
		this.name = "HarnessError";
	}
}

/**
 * The one interface every harness implements.
 *
 * Errors split in two: a turn that cannot begin throws HarnessError from
 * send(); a turn that began and went wrong ends with status "failed".
 */
export interface HarnessAdapter {
	readonly id: string;
	/** Pure and stable: same answer every call, no side effects. */
	capabilities(): HarnessCapabilities;
	start(options?: StartOptions): Promise<HarnessSession>;
	send(sessionId: string, input: TurnInput): HarnessTurn;
	/** True when a running turn was told to stop; false for an unknown or finished turn. */
	cancel(turnId: string): Promise<boolean>;
	/** Cancels any running turn and forgets the session. Safe to call twice. */
	stop(sessionId: string): Promise<void>;
}

type Body<E> = E extends HarnessEvent ? Omit<E, "seq" | "turnId"> : never;

/**
 * The event log behind one turn: numbers events, buffers them for late
 * readers, and closes after turn.ended. Adapters use it so every one of them
 * gets ordering and replay right the same way.
 */
export class TurnLog {
	private readonly buffer: HarnessEvent[] = [];
	private readonly waiters: Array<() => void> = [];
	private ended: TurnEnded | null = null;
	private resolveDone!: (e: TurnEnded) => void;
	readonly done: Promise<TurnEnded>;

	constructor(readonly turnId: string) {
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}

	get isEnded(): boolean {
		return this.ended !== null;
	}

	/** Appends an event. Ignored once the turn has ended. */
	push(body: Body<HarnessEvent>): void {
		if (this.ended) return;
		const event = { ...body, seq: this.buffer.length, turnId: this.turnId } as HarnessEvent;
		this.buffer.push(event);
		if (event.type === "turn.ended") {
			this.ended = event;
			this.resolveDone(event);
		}
		for (const wake of this.waiters.splice(0)) wake();
	}

	/** The text.delta events so far, joined. */
	text(): string {
		let out = "";
		for (const e of this.buffer) if (e.type === "text.delta") out += e.text;
		return out;
	}

	async *read(): AsyncIterable<HarnessEvent> {
		let i = 0;
		while (true) {
			while (i < this.buffer.length) yield this.buffer[i++];
			if (this.ended) return;
			await new Promise<void>((wake) => this.waiters.push(wake));
		}
	}
}
