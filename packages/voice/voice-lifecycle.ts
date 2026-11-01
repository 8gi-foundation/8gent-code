/**
 * @8gent/voice — Voice-Complete Lifecycle
 *
 * The hands-free build loop as a pure state machine. Issue #2759 step 3:
 * "dictate task, hear plan, approve dispatch, steer, approve merge — zero
 * keyboard." Wave 1 shipped the shared grammar ({@link parseVoiceCommand}) that
 * turns a Whisper transcript into a canonical {@link VoiceIntent}. This module
 * is the layer above it: given the current lifecycle phase and an incoming
 * intent, it decides what happens next.
 *
 * Why a dedicated machine and not `if` statements in the TUI:
 *   1. **Safety.** A lifecycle verb must only fire in the phase where it is
 *      meaningful. "merge" said while a task is still being dictated must be a
 *      no-op with spoken feedback, never a real merge. The guards live here,
 *      once, so every surface (Ink TUI, Flow) inherits the same protection.
 *   2. **Narration.** A developer who cannot see the screen learns the loop by
 *      ear, so every transition carries a `speak` string. The surface pipes it
 *      to local TTS; the machine guarantees something is always said.
 *   3. **Testability.** No mic, no TTS, no daemon — pure `(state, event) ->
 *      transition`. The whole hands-free contract is unit-testable.
 *
 * The machine is driven by two kinds of event:
 *   - a spoken {@link VoiceCommand} (the user talking), and
 *   - a {@link LifecycleSignal} the surface reports back (the plan arrived, the
 *     agents finished, the run failed) — the asynchronous half of the loop that
 *     no amount of talking can produce.
 *
 * No I/O, no hardcoded work: the machine only ever emits an intent-to-act
 * ({@link LifecycleEffect}); the surface performs the real dispatch/merge.
 */

import type { VoiceCommand, VoiceIntent } from "./voice-grammar.js";

// ============================================
// Phases
// ============================================

/**
 * The phases of one hands-free unit of work. Linear in the happy path
 * (`idle -> composing -> planning -> plan_review -> working -> merge_review ->
 * idle`) with `stop`/`reject` escape hatches back toward `idle` at every stage.
 */
export type LifecyclePhase =
	| "idle" // nothing composed; waiting for the user to start dictating
	| "composing" // accumulating the dictated task in the buffer
	| "planning" // task submitted; waiting for the surface to produce a plan
	| "plan_review" // a plan is presented; awaiting approve / reject / revise
	| "working" // the fleet is running; steer or stop
	| "merge_review"; // work finished; awaiting merge / discard

/**
 * The abstract side effect a surface must perform for a transition. The machine
 * never touches the daemon or git itself — it names the action and the surface
 * carries it out. `arg` on the transition carries any payload (steer text).
 */
export type LifecycleEffect =
	| "none"
	| "request_plan" // submit the composed task; the surface plans it
	| "revise_plan" // apply a spoken correction to the pending plan
	| "dispatch" // start the approved plan on the agent fleet
	| "steer" // send a mid-flight correction to the running fleet
	| "abort" // cancel the running work
	| "discard" // throw away finished work without merging
	| "merge" // approve and merge the finished work
	| "clear_input" // the composed buffer was cleared
	| "speak_help" // read the voice command list
	| "repeat"; // repeat the last spoken response

/**
 * Asynchronous progress the surface reports back into the machine. These are
 * the events the user cannot speak into being — the plan finished generating,
 * the fleet finished the build, the run failed.
 */
export type LifecycleSignal = "plan_ready" | "work_done" | "work_failed";

// ============================================
// State + transition
// ============================================

export interface LifecycleState {
	/** Current phase of the loop. */
	phase: LifecyclePhase;
	/** The task text dictated so far (present from `composing` onward). */
	buffer: string;
	/** The last thing the machine asked the surface to speak. */
	lastSpoken: string;
}

export interface LifecycleTransition {
	/** Phase before the event. */
	from: LifecyclePhase;
	/** Phase after the event. */
	to: LifecyclePhase;
	/** What the surface must do. `none` for pure phase/buffer changes. */
	effect: LifecycleEffect;
	/** Payload for the effect (e.g. the steer correction). Empty otherwise. */
	arg: string;
	/**
	 * True when the command was meaningful in the current phase. A `false` here
	 * means a guard blocked it (e.g. "merge" with nothing to merge); the effect
	 * is `none` and `speak` explains why.
	 */
	accepted: boolean;
	/** What the surface should speak. Never empty — every event is narrated. */
	speak: string;
	/** The full state after the event, for the surface to render. */
	state: LifecycleState;
}

/** The initial state of a fresh voice session. */
export function initialLifecycleState(): LifecycleState {
	return { phase: "idle", buffer: "", lastSpoken: "" };
}

// ============================================
// Helpers
// ============================================

function appendDictation(buffer: string, text: string): string {
	if (!text) return buffer;
	if (!buffer) return text;
	return `${buffer} ${text}`;
}

function dropLastWord(buffer: string): string {
	const words = buffer.trim().split(/\s+/).filter(Boolean);
	words.pop();
	return words.join(" ");
}

/** A short spoken summary of the buffer, so narration stays glanceable by ear. */
function bufferPreview(buffer: string): string {
	const words = buffer.trim().split(/\s+/).filter(Boolean);
	if (words.length <= 12) return buffer.trim();
	return `${words.slice(0, 12).join(" ")}…`;
}

function makeTransition(
	from: LifecyclePhase,
	to: LifecyclePhase,
	effect: LifecycleEffect,
	speak: string,
	buffer: string,
	arg = "",
	accepted = true,
): LifecycleTransition {
	return {
		from,
		to,
		effect,
		arg,
		accepted,
		speak,
		state: { phase: to, buffer, lastSpoken: speak },
	};
}

/**
 * A command that has no meaning in the current phase: no effect, no phase
 * change, but always narrated so a keyboard-free user is never left in silence.
 */
function rejected(state: LifecycleState, speak: string): LifecycleTransition {
	return {
		from: state.phase,
		to: state.phase,
		effect: "none",
		arg: "",
		accepted: false,
		speak,
		state: { ...state, lastSpoken: speak },
	};
}

// ============================================
// Reducer — voice command
// ============================================

/**
 * Apply a spoken {@link VoiceCommand} to the lifecycle. Pure: same state + same
 * command always yields the same transition.
 *
 * Universal intents (`help`, `repeat`, `cancel`) are handled first and work in
 * every phase. Everything else is dispatched by phase, and any lifecycle verb
 * arriving in a phase where it is not meaningful is safely {@link rejected}.
 */
export function reduceVoiceCommand(
	state: LifecycleState,
	command: VoiceCommand,
): LifecycleTransition {
	const { intent, arg } = command;

	// --- Universal intents (phase-independent) ---
	if (intent === "help") {
		return makeTransition(
			state.phase,
			state.phase,
			"speak_help",
			"Here are the voice commands.",
			state.buffer,
		);
	}
	if (intent === "repeat") {
		const speak = state.lastSpoken || "Nothing has been said yet.";
		return {
			from: state.phase,
			to: state.phase,
			effect: "repeat",
			arg: "",
			accepted: true,
			// Repeat must not overwrite lastSpoken, or a second "repeat" loses the
			// thing the user is trying to hear again.
			speak,
			state: { ...state },
		};
	}
	if (intent === "cancel") {
		// Dismiss the current voice interaction but keep session + buffer intact.
		return makeTransition(state.phase, state.phase, "none", "Okay.", state.buffer);
	}

	switch (state.phase) {
		// ----------------------------------------
		case "idle":
			if (intent === "dictate") {
				const buffer = arg;
				return makeTransition(
					"idle",
					"composing",
					"none",
					`Dictating. ${bufferPreview(buffer)}`,
					buffer,
				);
			}
			return rejected(state, phaseHint("idle", intent));

		// ----------------------------------------
		case "composing":
			switch (intent) {
				case "dictate": {
					const buffer = appendDictation(state.buffer, arg);
					return makeTransition("composing", "composing", "none", bufferPreview(buffer), buffer);
				}
				case "undo_word": {
					const buffer = dropLastWord(state.buffer);
					const to = buffer.length === 0 ? "idle" : "composing";
					return makeTransition(
						"composing",
						to,
						"none",
						buffer ? `Removed. ${bufferPreview(buffer)}` : "Input empty.",
						buffer,
					);
				}
				case "scratch":
					return makeTransition("composing", "idle", "clear_input", "Cleared.", "");
				case "submit":
					if (state.buffer.trim().length === 0) {
						return rejected(state, "Nothing to submit yet. Dictate a task first.");
					}
					return makeTransition(
						"composing",
						"planning",
						"request_plan",
						"Working on a plan.",
						state.buffer,
					);
				default:
					return rejected(state, phaseHint("composing", intent));
			}

		// ----------------------------------------
		case "planning":
			// The plan is being generated; the only spoken control is to bail out.
			if (intent === "stop") {
				return makeTransition("planning", "idle", "abort", "Cancelled. Ready for a new task.", "");
			}
			return rejected(state, "Still preparing the plan. Say stop to cancel.");

		// ----------------------------------------
		case "plan_review":
			switch (intent) {
				case "approve":
				case "dispatch":
					return makeTransition(
						"plan_review",
						"working",
						"dispatch",
						"Approved. Dispatching the plan.",
						state.buffer,
					);
				case "reject":
					// Keep the dictated task so the user can revise it, not retype it.
					return makeTransition(
						"plan_review",
						"composing",
						"none",
						"Rejected. Back to your task. Steer it or resubmit.",
						state.buffer,
					);
				case "steer":
					if (arg.trim().length === 0) {
						return rejected(state, "Say the correction after steer.");
					}
					return makeTransition(
						"plan_review",
						"plan_review",
						"revise_plan",
						`Revising the plan: ${arg}`,
						state.buffer,
						arg,
					);
				case "stop":
					return makeTransition(
						"plan_review",
						"idle",
						"abort",
						"Cancelled. Ready for a new task.",
						"",
					);
				default:
					return rejected(state, phaseHint("plan_review", intent));
			}

		// ----------------------------------------
		case "working":
			switch (intent) {
				case "steer":
					if (arg.trim().length === 0) {
						return rejected(state, "Say the correction after steer.");
					}
					return makeTransition(
						"working",
						"working",
						"steer",
						`Steering: ${arg}`,
						state.buffer,
						arg,
					);
				case "stop":
					return makeTransition(
						"working",
						"idle",
						"abort",
						"Stopping the run. Ready for a new task.",
						"",
					);
				default:
					// Guard: approve/dispatch/merge said mid-run must not fire.
					return rejected(state, phaseHint("working", intent));
			}

		// ----------------------------------------
		case "merge_review":
			switch (intent) {
				case "merge":
				case "approve":
					return makeTransition(
						"merge_review",
						"idle",
						"merge",
						"Merging. Ready for the next task.",
						"",
					);
				case "reject":
					return makeTransition(
						"merge_review",
						"idle",
						"discard",
						"Discarded without merging. Ready for a new task.",
						"",
					);
				case "stop":
					return makeTransition(
						"merge_review",
						"idle",
						"abort",
						"Left unmerged. Ready for a new task.",
						"",
					);
				default:
					return rejected(state, phaseHint("merge_review", intent));
			}
	}
}

// ============================================
// Reducer — asynchronous signal
// ============================================

/**
 * Apply a {@link LifecycleSignal} the surface reports back (plan generated,
 * fleet finished, run failed). These are the transitions the user cannot speak
 * into being. Out-of-phase signals are ignored (no phase change, narrated).
 */
export function reduceLifecycleSignal(
	state: LifecycleState,
	signal: LifecycleSignal,
): LifecycleTransition {
	switch (signal) {
		case "plan_ready":
			if (state.phase !== "planning") return rejected(state, state.lastSpoken || "");
			return makeTransition(
				"planning",
				"plan_review",
				"none",
				"Here is the plan. Say approve to dispatch, or steer to change it.",
				state.buffer,
			);
		case "work_done":
			if (state.phase !== "working") return rejected(state, state.lastSpoken || "");
			return makeTransition(
				"working",
				"merge_review",
				"none",
				"Work is done. Say merge to ship it, or reject to discard.",
				state.buffer,
			);
		case "work_failed":
			if (state.phase !== "working") return rejected(state, state.lastSpoken || "");
			// Keep the task so the user can steer and re-dispatch by voice.
			return makeTransition(
				"working",
				"composing",
				"none",
				"The run failed. Back to your task. Steer it and resubmit.",
				state.buffer,
			);
	}
}

// ============================================
// Phase hints (spoken feedback for blocked verbs)
// ============================================

/** What the user can usefully say in each phase, for `rejected` narration. */
const PHASE_ACTIONS: Record<LifecyclePhase, string> = {
	idle: "Dictate a task to begin.",
	composing: "Keep dictating, or say submit.",
	planning: "Wait for the plan, or say stop.",
	plan_review: "Say approve, reject, or steer.",
	working: "Say steer to correct it, or stop.",
	merge_review: "Say merge or reject.",
};

function phaseHint(phase: LifecyclePhase, intent: VoiceIntent): string {
	return `Can't ${spokenVerb(intent)} right now. ${PHASE_ACTIONS[phase]}`;
}

function spokenVerb(intent: VoiceIntent): string {
	switch (intent) {
		case "approve":
			return "approve";
		case "reject":
			return "reject";
		case "dispatch":
			return "dispatch";
		case "merge":
			return "merge";
		case "steer":
			return "steer";
		case "submit":
			return "submit";
		case "scratch":
			return "clear";
		case "undo_word":
			return "undo";
		case "newline":
			return "add a line";
		case "stop":
			return "stop";
		default:
			return "do that";
	}
}

// ============================================
// Stateful wrapper
// ============================================

/**
 * A thin stateful wrapper over the pure reducers for surfaces that prefer to
 * hold the machine as an object (the Ink TUI). It owns the current state and
 * exposes the same two events. The reducers remain the source of truth and stay
 * independently testable.
 */
export class VoiceLifecycle {
	private state: LifecycleState;

	constructor(initial: LifecycleState = initialLifecycleState()) {
		this.state = initial;
	}

	/** Current immutable snapshot. */
	getState(): Readonly<LifecycleState> {
		return { ...this.state };
	}

	/** Current phase, for a quick UI check. */
	get phase(): LifecyclePhase {
		return this.state.phase;
	}

	/** The task text composed so far. */
	get buffer(): string {
		return this.state.buffer;
	}

	/** Feed a spoken command; advances state and returns the transition. */
	command(command: VoiceCommand): LifecycleTransition {
		const transition = reduceVoiceCommand(this.state, command);
		this.state = transition.state;
		return transition;
	}

	/** Feed an asynchronous surface signal; advances state and returns it. */
	signal(signal: LifecycleSignal): LifecycleTransition {
		const transition = reduceLifecycleSignal(this.state, signal);
		this.state = transition.state;
		return transition;
	}

	/** Reset to a fresh idle session. */
	reset(): void {
		this.state = initialLifecycleState();
	}
}
