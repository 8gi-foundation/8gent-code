/**
 * 8gent Huddle - the floor protocol (Phase 0 of docs/8GENT-HUDDLE-SPEC.md).
 *
 * A pure, daemon-owned state machine. Officers have ZERO floor verbs: no frame
 * an officer can emit ever touches the floor. The daemon (via FloorMachine)
 * grants and releases it unilaterally, on its own timers. That is the whole
 * deadlock argument (spec section 3.4): there is one lock, no participant ever
 * holds it while waiting on another, and every grant is bounded by an
 * independent, daemon-armed timer. See the spec for the full proof.
 *
 * This module has NO dependency on the daemon (no AgentPool, no TableStore, no
 * WebSocket). The actual IO - calling a local model, posting a channel message
 * - is injected through FloorCallbacks and implemented in
 * packages/daemon/huddle-routes.ts. That keeps this state machine runnable and
 * fully testable with plain stubs, in milliseconds, with no store and no model.
 *
 * PHASE 0 SCOPE (see docs/8GENT-HUDDLE-SPEC.md section 11 + the task that
 * commissioned this file): the floor protocol, ordered turns, human
 * interruption, and the chair seat (presence resolution + compacted digest
 * budget guard). NOT built here: SlideSpec/rendering, the stage surface,
 * Supertonic narration, SPILL speculation/pre-generation, the bake, zen-gen.
 * Voice is not wired here either - TableVoice.swift already speaks every
 * agent's channel post serially, so an ordered turn posted through the normal
 * gated post_to_channel path is spoken automatically with no new audio path.
 *
 * PHASE 0 SIMPLIFICATIONS, stated honestly (both deliberate, both documented
 * in the final report, neither hidden):
 *   1. Ring ordering is roster order with the chair removed - NOT the
 *      substrate-alternating permutation of spec section 9.4 (SPILL/scheduling
 *      is Phase 1b). It is still a pure function of (roster, chair).
 *   2. A SPEAKING phase has no real "audio ended" signal in Phase 0 (there is
 *      no stage yet). The daemon uses a deterministic reading-time estimate
 *      (words / 2.6 wps, spec section 5.4) as the turn's spoken duration and
 *      releases when that elapses. That release is reported as reason
 *      "yielded" (the expected, designed completion path for THIS phase), not
 *      "deadline" - "deadline" is reserved for a genuine overrun (PREPARE
 *      budget exceeded, or the absolute MAX_TURN_MS ceiling). Phase 1 replaces
 *      the estimate with a real stage_ready/audio-ended round trip and at that
 *      point "deadline" on a SPEAKING release will correctly mean "hung".
 */

// ── Constants (spec section 3.2 + section 10.5) ────────────────────────────

/** Local model 15-90s worst case, plus render/probe. Per-huddle overridable
 *  via huddle:open.budgetMs (also what lets tests run in milliseconds). */
export const PREPARE_BUDGET_MS = 120_000;
/** Covers audio start jitter; reused here as the tail on the reading-time
 *  estimate that stands in for a real SPEAKING duration in Phase 0. */
export const SPEAK_GRACE_MS = 500;
/** Absolute ceiling on any single turn regardless of phase. */
export const MAX_TURN_MS = 180_000;
export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_MAX_DURATION_MS = 1_200_000;
/** A 9th raise coalesces into the pending queue rather than growing it. */
export const RAISE_QUEUE_MAX = 8;
/** No human:* frame within this window of a chair grant means absent. */
export const CHAIR_PRESENCE_TIMEOUT_MS = 90_000;

export const READING_WORDS_PER_SECOND = 2.6;
export const READING_MS_FLOOR = 3_500;
export const READING_MS_CEILING = 20_000;

export const CHAIR_DIGEST_LINE_CAP = 200;
/** Hard, loud-failure ceiling on the assembled chair prompt (spec 10.5) -
 *  apfel's real context window is 4096 tokens; failing loudly above this is
 *  the rule, never letting the backend truncate silently. */
export const CHAIR_PROMPT_TOKEN_BUDGET = 2000;

/** The two - and ONLY two - identities the chair seat can ever resolve to. */
export const CHAIR_HUMAN_ID = "human:james";
export const CHAIR_AGENT_ID = "agent:8EO";

// ── Types ────────────────────────────────────────────────────────────────

export type FloorPhase = "idle" | "open" | "preparing" | "speaking" | "closing" | "closed";
export type Seat = "ring" | "chair";
export type ReleaseReason = "yielded" | "deadline" | "cut" | "error" | "skipped";
export type ChairMode = "auto" | "human" | "agent";
export type ChairResolved = "human" | "agent";
export type ChairResolutionReason = "explicit" | "presence" | "absence" | "chair_timeout";

export interface ChairResolution {
	chair: string;
	resolved: ChairResolved;
	reason: ChairResolutionReason;
}

export interface HuddleOpenConfig {
	huddleId: string;
	channelId: string;
	/** The human who opened the huddle - counts as presence evidence at open
	 *  (spec 10.3: opening a huddle IS a human:* participant acting). */
	openedBy: string;
	/** The full roster as declared at open, INCLUDING the chair candidate. */
	roster: string[];
	topic: string;
	/** Declared chair candidate. Must be CHAIR_HUMAN_ID or CHAIR_AGENT_ID. */
	chair: string;
	chairMode: ChairMode;
	maxRounds: number;
	maxDurationMs: number;
	/** Per-huddle override of PREPARE_BUDGET_MS (also the chair's human-wait
	 *  budget before falling through to the agent). Lets tests run fast. */
	prepareBudgetMs: number;
	/**
	 * Test-only override of the SPEAKING phase duration (normally
	 * estimateReadingMs(text) + SPEAK_GRACE_MS). Real huddles never set this;
	 * it exists so fuzz/termination tests can run hundreds of huddles in
	 * milliseconds instead of minutes without changing the state machine's
	 * logic at all - only the wall-clock cost of the estimate step it replaces.
	 */
	speakMsOverride?: number;
}

export interface TurnRecord {
	turnId: string;
	/** Monotonic across the whole huddle, 0-based. */
	index: number;
	/** 1-based round number. */
	round: number;
	holder: string;
	seat: Seat;
	/** True for a raise/cut interjection - out of band, never advances the ring. */
	interject: boolean;
	text?: string;
	reason: ReleaseReason;
	startedAt: number;
	endedAt: number;
	chairResolution?: ChairResolution;
}

export interface PrepareContext {
	huddleId: string;
	turnId: string;
	holder: string;
	seat: Seat;
	round: number;
	topic: string;
	/** Completed ring turns earlier in THIS round (chair sees the full round). */
	priorTurnsThisRound: TurnRecord[];
}

export interface HuddleSnapshot {
	id: string;
	channelId: string;
	roster: string[];
	ring: string[];
	chair: string;
	chairMode: ChairMode;
	topic: string;
	maxRounds: number;
	maxDurationMs: number;
	openedAt: number;
	phase: FloorPhase;
	round: number;
	currentTurnId: string | null;
	currentHolder: string | null;
	currentSeat: Seat | null;
	turns: TurnRecord[];
}

export type HuddleOutFrame =
	| { type: "huddle:opened"; huddleId: string; huddle: HuddleSnapshot }
	| { type: "huddle:state"; huddleId: string; huddle: HuddleSnapshot }
	| {
			type: "huddle:floor";
			huddleId: string;
			turnId: string;
			holder: string;
			seat: Seat;
			phase: "preparing";
			deadline: number;
			round: number;
	  }
	| { type: "huddle:floor_released"; huddleId: string; turnId: string; reason: ReleaseReason }
	| {
			type: "huddle:chair_resolved";
			huddleId: string;
			chair: string;
			resolved: ChairResolved;
			reason: ChairResolutionReason;
	  }
	// A huddle is a group call: people come and go while it is running.
	| {
			type: "huddle:roster";
			huddleId: string;
			change: "joined" | "left";
			participantId: string;
			ring: string[];
	  }
	| { type: "huddle:closed"; huddleId: string; turns: TurnRecord[] }
	| { type: "huddle:error"; huddleId?: string; turnId?: string; code: string; message: string };

/**
 * Result of a human-initiated action, distinguishing WHY it didn't move the
 * floor: "forbidden" (a HUDDLE_FORBIDDEN was broadcast AND should also be
 * correlated directly back to the requesting connection) from "dropped"
 * (spec 3.4.5's idempotent stale-turnId behaviour - silently no-ops, no
 * error, by design).
 */
export type ActionResult = "ok" | "forbidden" | "dropped";

export interface FloorCallbacks {
	/** Emit a wire frame. The glue broadcasts it to the channel's subscribers. */
	emit(frame: HuddleOutFrame): void;
	/**
	 * Called once per agent grant (ring officer OR the agent-resolved chair).
	 * Resolve with the reply text, or reject/throw to record the turn as an
	 * error. Raced internally against prepareBudgetMs; a resolution that
	 * arrives after the race is already decided is discarded (guarded here,
	 * never by the caller).
	 */
	prepareAgentTurn(ctx: PrepareContext): Promise<string>;
	/** Called once an agent turn's final text is known, so the glue can post it
	 *  to the channel (which is also how TableVoice ends up speaking it). Never
	 *  called for a turn with no text. */
	postTurnText?(ctx: PrepareContext, text: string): void | Promise<void>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/** 24 hex chars from a fresh UUID, mirroring table/ids.ts's convention. */
function hex24(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function newHuddleId(): string {
	return `huddle_${hex24()}`;
}

export function newTurnId(): string {
	return `turn_${hex24()}`;
}

/**
 * Ring = roster with the chair candidate and duplicates removed, order
 * preserved. Pure function of (roster, chair) - same inputs, same ring, every
 * time. Phase 1b replaces this with the substrate-alternating permutation of
 * spec section 9.4; this is the honest, simpler Phase 0 version (see the file
 * header).
 */
export function deriveRing(roster: readonly string[], chair: string): string[] {
	const seen = new Set<string>();
	const ring: string[] = [];
	for (const p of roster) {
		if (p === chair) continue;
		if (seen.has(p)) continue;
		seen.add(p);
		ring.push(p);
	}
	return ring;
}

/**
 * Deterministic reading-time estimate (spec section 5.4's quiet-hours
 * fallback, reused here as the Phase 0 stand-in for a measured audio
 * duration): words / 2.6 words-per-second, floored at 3.5s, capped at 20s.
 */
export function estimateReadingMs(text: string): number {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	if (words === 0) return READING_MS_FLOOR;
	const ms = Math.round((words / READING_WORDS_PER_SECOND) * 1000);
	return Math.min(READING_MS_CEILING, Math.max(READING_MS_FLOOR, ms));
}

/** First sentence of `text`, whitespace-collapsed, hard-capped at `cap` chars. */
export function firstSentence(text: string, cap: number = CHAIR_DIGEST_LINE_CAP): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	const m = trimmed.match(/^[^.!?]*[.!?]/);
	const sentence = (m ? m[0] : trimmed).trim();
	return sentence.length > cap ? `${sentence.slice(0, Math.max(0, cap - 1))}…` : sentence;
}

/** One line per turn: "<Name> (<CODE>): <first sentence, <=200 chars>". Pure,
 *  no model call - the whole "compacted digest" of spec section 10.5. */
export function buildChairDigest(entries: readonly { code: string; name: string; text: string }[]): string {
	return entries.map((e) => `${e.name} (${e.code}): ${firstSentence(e.text)}`).join("\n");
}

/** Deliberately crude, deterministic, tokenizer-free estimate (~4 chars per
 *  token) - good enough for a hard budget guard, not a billing figure. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Loud failure, never silent truncation (spec 10.5). Throws when `prompt`
 * would not fit apfel's real 4096-token window with headroom for generation.
 */
export function assertPromptBudget(prompt: string, maxTokens: number = CHAIR_PROMPT_TOKEN_BUDGET): void {
	const est = estimateTokens(prompt);
	if (est > maxTokens) {
		throw new Error(
			`chair prompt exceeds budget: ~${est} estimated tokens > ${maxTokens} - refusing to send it ` +
				`to a 4096-token backend to be silently truncated`,
		);
	}
}

// ── FloorMachine ─────────────────────────────────────────────────────────

interface CurrentTurn {
	turnId: string;
	holder: string;
	seat: Seat;
	interject: boolean;
	phase: "preparing" | "speaking";
	startedAt: number;
	text: string;
	chairResolution?: ChairResolution;
}

export class FloorMachine {
	readonly config: HuddleOpenConfig;
	private readonly ring: string[];
	private readonly callbacks: FloorCallbacks;

	private phase: FloorPhase = "idle";
	private round = 0; // 0-based internally; TurnRecord.round is 1-based
	private ringPos = 0;
	private openedAt = 0;
	private closeRequested = false;
	private lastHumanFrameAt = 0;
	/** The human who most recently acted. The chair turn goes to THIS id, not to
	 *  a hardcoded name, so whoever is actually at the table gets the last word.
	 *  Defaults to the canonical id so behaviour is unchanged when that is who
	 *  is connected. */
	private lastHumanActor: string = CHAIR_HUMAN_ID;

	private current: CurrentTurn | null = null;
	private readonly turns: TurnRecord[] = [];
	private readonly raiseQueue: string[] = [];
	private pendingCutter: string | undefined;

	private prepareTimer: ReturnType<typeof setTimeout> | null = null;
	private speakTimer: ReturnType<typeof setTimeout> | null = null;
	private maxTurnTimer: ReturnType<typeof setTimeout> | null = null;
	private chairHumanTimer: ReturnType<typeof setTimeout> | null = null;
	private wallClockTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config: HuddleOpenConfig, callbacks: FloorCallbacks) {
		if (config.chair !== CHAIR_HUMAN_ID && config.chair !== CHAIR_AGENT_ID) {
			throw new Error(`chair must be "${CHAIR_HUMAN_ID}" or "${CHAIR_AGENT_ID}", got "${config.chair}"`);
		}
		this.config = config;
		// The declared chair is a SEAT ("the human seat" / "the agent seat"), and
		// CHAIR_HUMAN_ID is its canonical name. The human actually sitting in it
		// may have a different id: the Table pins its human as "human:local"
		// unless EIGHT_DAEMON_TOKEN is set, and it is not set on the reference
		// machine. Resolve the seat to the real occupant at open.
		//
		// Two things went wrong without this, both measured live 2026-08-06:
		// deriveRing removed the literal "human:james", so a roster containing
		// "human:local" left the human IN THE RING - speaking FIRST, the exact
		// opposite of the chair-last design - and the chair turn was then granted
		// to an id no connected client answers to, so it sat unclaimed until the
		// deadline. The seat that exists to give the human the last word was
		// unreachable by the human.
		this.lastHumanActor =
			config.chair === CHAIR_HUMAN_ID && config.openedBy.startsWith("human:")
				? config.openedBy
				: CHAIR_HUMAN_ID;
		const seatOccupant = config.chair === CHAIR_HUMAN_ID ? this.lastHumanActor : config.chair;
		this.ring = deriveRing(config.roster, seatOccupant);
		this.callbacks = callbacks;
	}

	// ── lifecycle ──────────────────────────────────────────────────────────

	open(): void {
		if (this.phase !== "idle") return;
		this.phase = "open";
		this.openedAt = Date.now();
		this.noteHumanFrame(this.config.openedBy);
		this.emit({ type: "huddle:opened", huddleId: this.config.huddleId, huddle: this.getSnapshot() });
		// Independent wall-clock backstop (spec 3.4.4): fires even if a huddle
		// somehow never sees a single [RELEASING] transition.
		this.wallClockTimer = setTimeout(() => this.onWallClock(), this.config.maxDurationMs);
		this.grantNext();
	}

	getSnapshot(): HuddleSnapshot {
		return {
			id: this.config.huddleId,
			channelId: this.config.channelId,
			roster: [...this.config.roster],
			ring: [...this.ring],
			chair: this.config.chair,
			chairMode: this.config.chairMode,
			topic: this.config.topic,
			maxRounds: this.config.maxRounds,
			maxDurationMs: this.config.maxDurationMs,
			openedAt: this.openedAt,
			phase: this.phase,
			round: this.round + (this.phase === "closed" || this.phase === "closing" ? 0 : 1),
			currentTurnId: this.current?.turnId ?? null,
			currentHolder: this.current?.holder ?? null,
			currentSeat: this.current?.seat ?? null,
			turns: this.turns.slice(),
		};
	}

	// ── human-initiated actions - the ONLY ways the floor ever moves early ──

	/** Queued; honoured at the next [RELEASING]. Human only. */
	raise(actor: string): ActionResult {
		if (!this.isHuman(actor)) {
			this.forbid(actor, "huddle:raise is human-only; officers have no floor verbs");
			return "forbidden";
		}
		this.noteHumanFrame(actor);
		if (this.phase === "closed" || this.phase === "closing") return "dropped";
		if (this.raiseQueue.includes(actor)) return "ok"; // dedupe
		if (this.raiseQueue.length >= RAISE_QUEUE_MAX) return "ok"; // 9th coalesces
		this.raiseQueue.push(actor);
		return "ok";
	}

	/**
	 * Bring someone into a huddle that is already running. Human only.
	 *
	 * A huddle is a group call, not a fixed committee: James asked to "add and
	 * remove 8gents at will". The ring was derived once in the constructor and
	 * never revisited, so the roster you opened with was the roster you were
	 * stuck with.
	 *
	 * They join at the END of the ring, so they speak this round if it has not
	 * reached them yet, and next round otherwise. Never inserted ahead of the
	 * current position - that would replay a seat somebody already had.
	 */
	invite(actor: string, participantId: string): ActionResult {
		if (!this.isHuman(actor)) {
			this.forbid(actor, "huddle:invite is human-only; officers do not pick the room");
			return "forbidden";
		}
		this.noteHumanFrame(actor);
		if (this.phase === "closed" || this.phase === "closing") return "dropped";
		if (!participantId || participantId === this.lastHumanActor) return "dropped";
		if (this.ring.includes(participantId)) return "ok"; // already here, idempotent
		this.ring.push(participantId);
		this.config.roster.push(participantId);
		this.emit({
			type: "huddle:roster",
			huddleId: this.config.huddleId,
			change: "joined",
			participantId,
			ring: [...this.ring],
		});
		return "ok";
	}

	/**
	 * Drop someone from a running huddle. Human only.
	 *
	 * If they hold the floor right now, their turn is released first - otherwise
	 * the room would sit waiting on somebody who is no longer in it. Removing an
	 * EARLIER ring member also pulls ringPos back by one, so the next grant does
	 * not skip whoever was standing behind them.
	 */
	drop(actor: string, participantId: string): ActionResult {
		if (!this.isHuman(actor)) {
			this.forbid(actor, "huddle:drop is human-only; officers do not pick the room");
			return "forbidden";
		}
		this.noteHumanFrame(actor);
		if (this.phase === "closed" || this.phase === "closing") return "dropped";
		const at = this.ring.indexOf(participantId);
		if (at < 0) return "dropped"; // not in the ring, idempotent
		this.ring.splice(at, 1);
		this.config.roster = this.config.roster.filter((p) => p !== participantId);
		if (at < this.ringPos) this.ringPos -= 1;
		for (let i = this.raiseQueue.length - 1; i >= 0; i--) {
			if (this.raiseQueue[i] === participantId) this.raiseQueue.splice(i, 1);
		}
		this.emit({
			type: "huddle:roster",
			huddleId: this.config.huddleId,
			change: "left",
			participantId,
			ring: [...this.ring],
		});
		// Holding the floor on the way out: release it so the room moves on.
		if (this.current?.holder === participantId) this.releaseCurrent("skipped");
		return "ok";
	}

	/** Hard preempt. Human only. A stale turnId is dropped, silently, idempotently. */
	cut(actor: string, turnId: string): ActionResult {
		if (!this.isHuman(actor)) {
			this.forbid(actor, "huddle:cut is human-only; officers have no floor verbs");
			return "forbidden";
		}
		this.noteHumanFrame(actor);
		if (this.phase === "closed" || this.phase === "closing") return "dropped";
		if (!this.current || this.current.turnId !== turnId) return "dropped"; // stale
		this.pendingCutter = actor;
		this.releaseCurrent("cut");
		return "ok";
	}

	/** Releases the CALLER's own turn. Human only; must be the current holder. */
	yield(actor: string, turnId: string): ActionResult {
		if (!this.isHuman(actor)) {
			this.forbid(actor, "huddle:yield is human-only; the daemon releases agent turns itself");
			return "forbidden";
		}
		if (!this.current || this.current.turnId !== turnId) return "dropped"; // stale
		if (this.current.holder !== actor) {
			this.forbid(actor, "cannot yield a turn you do not hold");
			return "forbidden";
		}
		this.noteHumanFrame(actor);
		this.releaseCurrent("yielded");
		return "ok";
	}

	/** Human only. The current turn (if any) finishes naturally, then CLOSING. */
	close(actor: string): ActionResult {
		if (!this.isHuman(actor)) {
			this.forbid(actor, "huddle:close is human-only");
			return "forbidden";
		}
		this.noteHumanFrame(actor);
		this.closeRequested = true;
		if (!this.current) this.finishClosing();
		return "ok";
	}

	/**
	 * A human posted a normal channel message. Two effects: it is presence
	 * evidence (spec 10.3), and if the poster is the CURRENT holder, the text
	 * becomes (part of) their TurnRecord - a human "speaks" by typing normally,
	 * there is no separate capture step in Phase 0 (no stage).
	 */
	noteHumanTurnText(actor: string, text: string): void {
		this.noteHumanFrame(actor);
		if (this.current && this.current.holder === actor && this.isHuman(actor)) {
			this.current.text = this.current.text ? `${this.current.text}\n${text}` : text;
		}
	}

	private noteHumanFrame(actor: string): void {
		if (!this.isHuman(actor)) return;
		this.lastHumanFrameAt = Date.now();
		// Remember WHO, not just WHEN. The chair turn used to be granted to the
		// literal CHAIR_HUMAN_ID, but the Table pins its human as "human:local"
		// unless EIGHT_DAEMON_TOKEN is set - and it is not set on the reference
		// machine. So the chair seat, which exists precisely to give James the
		// last word, was granted to an id no connected client answers to: the
		// officers would speak, then his turn would sit unclaimed until the
		// deadline. Presence detection was already prefix-based and correct; only
		// the identity handed the turn was hardcoded.
		this.lastHumanActor = actor;
	}

	private isHuman(id: string): boolean {
		return id.startsWith("human:");
	}

	private forbid(actor: string, message: string): void {
		this.emit({
			type: "huddle:error",
			huddleId: this.config.huddleId,
			code: "HUDDLE_FORBIDDEN",
			message: `${actor}: ${message}`,
		});
	}

	// ── granting ─────────────────────────────────────────────────────────

	private grantNext(): void {
		if (this.phase === "closed" || this.phase === "closing") return;
		if (this.closeRequested) {
			this.finishClosing();
			return;
		}
		if (this.raiseQueue.length > 0) {
			const next = this.raiseQueue.shift() as string;
			this.startTurn(next, "ring", { interject: true });
			return;
		}
		if (this.ringPos < this.ring.length) {
			this.startTurn(this.ring[this.ringPos], "ring", { interject: false });
			return;
		}
		this.grantChair();
	}

	private resolveChair(): ChairResolution {
		const mode = this.config.chairMode;
		if (mode === "agent") return { chair: CHAIR_AGENT_ID, resolved: "agent", reason: "explicit" };
		if (mode === "human") return { chair: this.lastHumanActor, resolved: "human", reason: "explicit" };
		// auto: present iff a human:* frame landed within CHAIR_PRESENCE_TIMEOUT_MS
		// of THIS grant. huddle:stage_ready never counts (there is no stage in
		// Phase 0 anyway) - only a real human action updates lastHumanFrameAt.
		const present = Date.now() - this.lastHumanFrameAt <= CHAIR_PRESENCE_TIMEOUT_MS;
		return present
			? { chair: this.lastHumanActor, resolved: "human", reason: "presence" }
			: { chair: CHAIR_AGENT_ID, resolved: "agent", reason: "absence" };
	}

	private grantChair(): void {
		const resolution = this.resolveChair();
		this.emit({
			type: "huddle:chair_resolved",
			huddleId: this.config.huddleId,
			chair: resolution.chair,
			resolved: resolution.resolved,
			reason: resolution.reason,
		});
		this.startTurn(resolution.chair, "chair", { interject: false, chairResolution: resolution });
	}

	private startTurn(
		holder: string,
		seat: Seat,
		opts: { interject: boolean; chairResolution?: ChairResolution },
	): void {
		const turnId = newTurnId();
		const startedAt = Date.now();
		const isHumanHolder = this.isHuman(holder);
		this.current = {
			turnId,
			holder,
			seat,
			interject: opts.interject,
			phase: "preparing",
			startedAt,
			text: "",
			chairResolution: opts.chairResolution,
		};

		const round1 = this.round + 1;
		const prepDeadline = startedAt + this.config.prepareBudgetMs;
		this.emit({
			type: "huddle:floor",
			huddleId: this.config.huddleId,
			turnId,
			holder,
			seat,
			phase: "preparing",
			deadline: prepDeadline,
			round: round1,
		});

		// Absolute ceiling, independent of phase (spec 3.2/3.4.2).
		this.maxTurnTimer = setTimeout(() => this.onMaxTurnExpired(turnId), MAX_TURN_MS);

		if (isHumanHolder) {
			this.current.phase = "speaking"; // no model call for a human turn
			if (seat === "chair") {
				// "The floor waits for him, bounded by PREPARE_BUDGET_MS. On expiry it
				// falls through to agent:8EO with reason: chair_timeout." (spec 10.3) -
				// applied whenever the RESOLVED chair is human, auto or explicit alike,
				// which is also the general no-deadlock guarantee of spec 3.4.3.
				this.chairHumanTimer = setTimeout(() => this.onChairHumanTimeout(turnId), this.config.prepareBudgetMs);
			}
			return;
		}

		// Agent turn: race prepareAgentTurn against prepareBudgetMs.
		this.prepareTimer = setTimeout(() => this.onPrepareDeadline(turnId), this.config.prepareBudgetMs);
		const ctx = this.contextFor(turnId, holder, seat, round1);
		this.callbacks.prepareAgentTurn(ctx).then(
			(text) => this.onPrepareResolved(turnId, text, undefined),
			(err) => this.onPrepareResolved(turnId, undefined, err),
		);
	}

	private contextFor(turnId: string, holder: string, seat: Seat, round1: number): PrepareContext {
		return {
			huddleId: this.config.huddleId,
			turnId,
			holder,
			seat,
			round: round1,
			topic: this.config.topic,
			priorTurnsThisRound: this.turns.filter((t) => t.round === round1),
		};
	}

	// ── agent turn resolution ────────────────────────────────────────────

	private onPrepareResolved(turnId: string, text: string | undefined, err: unknown): void {
		if (!this.current || this.current.turnId !== turnId || this.current.phase !== "preparing") return; // stale
		this.clearTimer("prepareTimer");
		const clean = (text ?? "").trim();
		if (err || !clean) {
			this.releaseCurrent(err ? "error" : "skipped");
			return;
		}
		this.current.text = clean;
		this.current.phase = "speaking";
		try {
			void this.callbacks.postTurnText?.(this.contextFor(turnId, this.current.holder, this.current.seat, this.round + 1), clean);
		} catch {
			// A posting failure must not stall the floor; the release timer below
			// still fires and the turn is still recorded (with its text) either way.
		}
		const speakMs = this.config.speakMsOverride ?? estimateReadingMs(clean) + SPEAK_GRACE_MS;
		this.speakTimer = setTimeout(() => this.onSpeakElapsed(turnId), speakMs);
	}

	private onPrepareDeadline(turnId: string): void {
		if (!this.current || this.current.turnId !== turnId || this.current.phase !== "preparing") return;
		this.releaseCurrent("deadline");
	}

	private onSpeakElapsed(turnId: string): void {
		if (!this.current || this.current.turnId !== turnId || this.current.phase !== "speaking") return;
		// The expected, designed completion path in Phase 0 (see file header) -
		// there is no stage yet, so the reading-time estimate elapsing IS the
		// turn ending, not a hang. Phase 1's real audio-ended signal replaces this.
		this.releaseCurrent("yielded");
	}

	private onMaxTurnExpired(turnId: string): void {
		if (!this.current || this.current.turnId !== turnId) return;
		this.releaseCurrent("deadline");
	}

	private onChairHumanTimeout(turnId: string): void {
		if (!this.current || this.current.turnId !== turnId) return;
		if (this.current.seat !== "chair" || !this.isHuman(this.current.holder)) return;
		this.clearAllCurrentTimers();
		const cur = this.current;
		this.current = null;
		this.recordTurn(cur, "deadline");
		this.emit({ type: "huddle:floor_released", huddleId: this.config.huddleId, turnId: cur.turnId, reason: "deadline" });
		this.emit({
			type: "huddle:chair_resolved",
			huddleId: this.config.huddleId,
			chair: CHAIR_AGENT_ID,
			resolved: "agent",
			reason: "chair_timeout",
		});
		// Same round - the agent chair now generates cold on the full record.
		this.startTurn(CHAIR_AGENT_ID, "chair", {
			interject: false,
			chairResolution: { chair: CHAIR_AGENT_ID, resolved: "agent", reason: "chair_timeout" },
		});
	}

	// ── release + round/termination bookkeeping ─────────────────────────

	private releaseCurrent(reason: ReleaseReason): void {
		if (!this.current) return;
		this.clearAllCurrentTimers();
		const cur = this.current;
		this.current = null;
		this.recordTurn(cur, reason);
		this.emit({ type: "huddle:floor_released", huddleId: this.config.huddleId, turnId: cur.turnId, reason });
		this.advanceAfterRelease(cur, reason);
	}

	private recordTurn(cur: CurrentTurn, reason: ReleaseReason): void {
		this.turns.push({
			turnId: cur.turnId,
			index: this.turns.length,
			round: this.round + 1,
			holder: cur.holder,
			seat: cur.seat,
			interject: cur.interject,
			text: cur.text || undefined,
			reason,
			startedAt: cur.startedAt,
			endedAt: Date.now(),
			chairResolution: cur.chairResolution,
		});
	}

	private advanceAfterRelease(cur: CurrentTurn, reason: ReleaseReason): void {
		if (this.phase === "closed" || this.phase === "closing") return;
		if (reason === "cut" && this.pendingCutter) {
			const cutter = this.pendingCutter;
			this.pendingCutter = undefined;
			this.startTurn(cutter, "ring", { interject: true });
			return;
		}
		this.pendingCutter = undefined;
		if (this.closeRequested) {
			this.finishClosing();
			return;
		}
		if (cur.interject) {
			// Out of band - never advances the ring position or the round.
			this.grantNext();
			return;
		}
		if (cur.seat === "chair") {
			this.round += 1;
			this.ringPos = 0;
			const elapsed = Date.now() - this.openedAt;
			if (this.round >= this.config.maxRounds || elapsed >= this.config.maxDurationMs) {
				this.finishClosing();
				return;
			}
			this.grantNext();
			return;
		}
		this.ringPos += 1;
		this.grantNext();
	}

	/**
	 * The independent wall-clock backstop (spec 3.4.4). Unlike a normal
	 * release, this does NOT resume the ring/chair/raise flow afterwards - it
	 * is the absolute guarantee that CLOSED is reached by maxDurationMs no
	 * matter what state the huddle is in (a stuck human turn nobody yielded, an
	 * exhausted raise queue, anything). A partial release-and-continue here
	 * would only be as reliable as everything downstream of it; this is not.
	 */
	private onWallClock(): void {
		if (this.phase === "closed" || this.phase === "closing") return;
		if (this.current) {
			this.clearAllCurrentTimers();
			const cur = this.current;
			this.current = null;
			this.recordTurn(cur, "deadline");
			this.emit({ type: "huddle:floor_released", huddleId: this.config.huddleId, turnId: cur.turnId, reason: "deadline" });
		}
		this.finishClosing();
	}

	private finishClosing(): void {
		if (this.phase === "closed") return;
		this.phase = "closing";
		this.clearTimer("wallClockTimer");
		this.phase = "closed";
		this.emit({ type: "huddle:closed", huddleId: this.config.huddleId, turns: this.turns.slice() });
	}

	// ── timers ───────────────────────────────────────────────────────────

	private clearTimer(name: "prepareTimer" | "speakTimer" | "maxTurnTimer" | "chairHumanTimer" | "wallClockTimer"): void {
		const handle = this[name];
		if (handle) clearTimeout(handle);
		this[name] = null;
	}

	private clearAllCurrentTimers(): void {
		this.clearTimer("prepareTimer");
		this.clearTimer("speakTimer");
		this.clearTimer("maxTurnTimer");
		this.clearTimer("chairHumanTimer");
	}

	private emit(frame: HuddleOutFrame): void {
		this.callbacks.emit(frame);
	}
}
