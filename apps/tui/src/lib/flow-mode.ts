/**
 * Flow modes (L3): how I am working right now, one word above permission mode.
 *
 *   act    default. Normal verbosity, keeps the user's permission setting.
 *   quiet  speaks only approvals and blockers, keeps the user's permission setting.
 *   think  think-aloud. Ceiling Ask: no shell or writes without asking.
 *
 * Listen is deferred (needs the notes store) and is not a FlowMode yet.
 *
 * Security boundary (spec section 4): the judge may only lower the permission
 * ceiling or ask. It never raises autonomy, never enters Infinite or Guarded,
 * never loosens System One. Only live user voice transcript is a signal; tool
 * output, files and model text are not. Judge timeout or malformed output is
 * "no change". This module holds mode state outside the model's reach and
 * never touches the permission mode itself.
 */

import {
	type PermissionMode,
	permissionRank,
	stricterMode,
} from "../../../../packages/permissions/permission-mode";

export type FlowMode = "act" | "quiet" | "think";
export const FLOW_MODES: readonly FlowMode[] = ["act", "think", "quiet"];
export const DEFAULT_FLOW_MODE: FlowMode = "act";

/** Who asked for the switch. Only the first four are the user. */
export type SwitchSource =
	| "user-key"
	| "user-command" // /mode
	| "user-phrase" // explicit spoken phrase from the live transcript
	| "user-answer" // "yes" to an inferred question
	| "judge"; // inferred from the live transcript

/** Where a transcript line came from. Only user-voice is eligible as a signal. */
export type SignalOrigin = "user-voice" | "tool-output" | "file" | "web" | "model-text";

export const INFERRED_ASK_TIMEOUT_MS = 5_000;
export const JUDGE_TIMEOUT_MS = 1_500;
export const OVERRIDE_NO_REPEAT_MS = 10 * 60 * 1000;
export const INFERRED_RATE_LIMIT_MS = 5 * 60 * 1000;

/** Permission ceiling a flow mode imposes. null = keep the user's own setting. */
const CEILING: Record<FlowMode, PermissionMode | null> = { act: null, quiet: null, think: "ask" };

/** Rank used to decide "raises autonomy". null ceiling = unbounded = highest. */
function ceilingRank(mode: FlowMode): number {
	const c = CEILING[mode];
	return c === null ? Number.MAX_SAFE_INTEGER : permissionRank(c);
}

export function isFlowMode(v: unknown): v is FlowMode {
	return typeof v === "string" && (FLOW_MODES as readonly string[]).includes(v);
}

/** The permission mode in force: the user's own, clamped by the flow ceiling. Never raised. */
export function effectivePermission(user: PermissionMode, mode: FlowMode): PermissionMode {
	const c = CEILING[mode];
	return c === null ? user : stricterMode(user, c);
}

export function flowModeLabel(mode: FlowMode): string {
	return mode === "think" ? "Think" : mode === "quiet" ? "Quiet" : "Act";
}

/** Next in the cycle key order. */
export function nextFlowMode(mode: FlowMode): FlowMode {
	return FLOW_MODES[(FLOW_MODES.indexOf(mode) + 1) % FLOW_MODES.length] as FlowMode;
}

/**
 * Pure gate. `to` is unknown on purpose: judge output is untrusted, so
 * "infinite", "guarded" or garbage must be rejected here, not upstream.
 * True means the switch may happen (a judge switch still needs the user's yes).
 */
export function canSwitch(from: FlowMode, to: unknown, source: SwitchSource): boolean {
	if (!isFlowMode(to)) return false;
	if (source !== "judge") return true; // user origin always wins
	return ceilingRank(to) <= ceilingRank(from); // judge: lower or equal ceiling only
}

// ── Spoken text ──────────────────────────────────────────────────────

export type SpeechKind = "reply" | "final-reply" | "approval" | "blocker";

/** Quiet: nothing but approvals and blockers. Act: final reply only. Think: every reply. */
export function shouldSpeak(mode: FlowMode, kind: SpeechKind): boolean {
	if (kind === "approval" || kind === "blocker") return true;
	if (mode === "quiet") return false;
	if (mode === "act") return kind === "final-reply";
	return true;
}

const NOT_YOURS = "Not switching, that is yours to set";

function announce(to: FlowMode): string {
	if (to === "quiet") return "Going quiet. Say 'back to work' to undo.";
	if (to === "think") return "Thinking out loud. Say 'back to work' to undo.";
	return "Back to work.";
}

function question(to: FlowMode): string {
	return to === "quiet"
		? "Want me to go quiet?"
		: to === "think"
			? "Want to think out loud?"
			: "Want me to get on with it?";
}

// ── Phrases and judge output ─────────────────────────────────────────

const PHRASES: ReadonlyArray<[RegExp, FlowMode]> = [
	[/\b(go quiet|be quiet|quiet mode|stop talking)\b/i, "quiet"],
	[/\b(think out loud|think aloud)\b/i, "think"],
	[/\b(back to work|go ahead and do it|act mode)\b/i, "act"],
];

/** An explicit phrase, only from live user voice. Anything else is ignored. */
export function parseExplicitPhrase(text: string, origin: SignalOrigin): FlowMode | null {
	if (origin !== "user-voice") return null;
	for (const [re, mode] of PHRASES) if (re.test(text)) return mode;
	return null;
}

export interface ModeProposal {
	to: unknown;
	reason?: string;
	signal?: string;
}

/** Judge output to a proposal, or null when timed out, malformed or not an object. */
export function parseJudgeOutput(raw: unknown): ModeProposal | null {
	if (raw === null || raw === undefined || raw === "timeout") return null;
	let obj: unknown = raw;
	if (typeof raw === "string") {
		try {
			obj = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (typeof obj !== "object" || obj === null || !("to" in obj)) return null;
	return obj as ModeProposal;
}

// ── Controller ───────────────────────────────────────────────────────

export interface LogEntry {
	at: number;
	from: FlowMode;
	to: unknown;
	source: SwitchSource | "ignored";
	accepted: boolean;
	why: string;
}

export interface Outcome {
	changed: boolean;
	mode: FlowMode;
	/** One spoken line, or undefined for silence. */
	say?: string;
	asking?: boolean;
}

export interface FlowModeController {
	readonly mode: FlowMode;
	readonly log: readonly LogEntry[];
	/** The one word for the footer. */
	footer(): string;
	userSwitch(to: unknown, source: "user-key" | "user-command"): Outcome;
	/** A line of live transcript. Explicit phrase applies at once; trusted voice only. */
	hear(text: string, origin: SignalOrigin): Outcome;
	/** Judge result for a transcript: raw output, "timeout" or garbage. */
	judge(raw: unknown, origin: SignalOrigin): Outcome;
	/** Reply to a pending question: "yes" switches, anything else declines. */
	answer(text: string): Outcome;
	/** Expire a pending question after 5 s. */
	tick(): Outcome;
	/** Restore the mode before the last judge switch in one step. */
	undo(): Outcome;
}

export function createFlowModeController(now: () => number = Date.now): FlowModeController {
	let mode: FlowMode = DEFAULT_FLOW_MODE;
	let prior: FlowMode | null = null; // set only when the judge changed the mode
	let judgeSet: FlowMode | null = null; // the mode the judge put us in, if still in it
	let pending: { to: FlowMode; at: number } | null = null;
	let lastInferredAt = Number.NEGATIVE_INFINITY;
	const blockedUntil = new Map<FlowMode, number>();
	const log: LogEntry[] = [];

	const rec = (to: unknown, source: LogEntry["source"], accepted: boolean, why: string) =>
		log.push({ at: now(), from: mode, to, source, accepted, why });
	const out = (changed: boolean, say?: string, asking = false): Outcome => ({
		changed,
		mode,
		say,
		asking,
	});

	function apply(to: FlowMode, source: SwitchSource): Outcome {
		const from = mode;
		// A user move out of a judge-made mode is an override: no re-proposal for 10 min.
		if (source !== "judge" && judgeSet !== null && from === judgeSet) {
			blockedUntil.set(judgeSet, now() + OVERRIDE_NO_REPEAT_MS);
		}
		if (source === "judge") {
			prior = from;
			judgeSet = to;
		} else {
			prior = null;
			judgeSet = null;
		}
		mode = to;
		pending = null;
		rec(to, source, true, "applied");
		return out(true, announce(to));
	}

	return {
		get mode() {
			return mode;
		},
		get log() {
			return log;
		},
		footer: () => flowModeLabel(mode),

		userSwitch(to, source) {
			if (!canSwitch(mode, to, source)) {
				rec(to, source, false, "unknown mode");
				return out(false);
			}
			if (to === mode) return out(false);
			return apply(to as FlowMode, source);
		},

		hear(text, origin) {
			const to = parseExplicitPhrase(text, origin);
			if (to === null) {
				if (origin !== "user-voice" && PHRASES.some(([re]) => re.test(text))) {
					rec(text, "ignored", false, `untrusted origin ${origin}`);
				}
				return out(false);
			}
			if (to === mode) return out(false);
			return apply(to, "user-phrase");
		},

		judge(raw, origin) {
			if (origin !== "user-voice") {
				rec(raw, "ignored", false, `untrusted origin ${origin}`);
				return out(false);
			}
			const p = parseJudgeOutput(raw);
			if (p === null) {
				rec(raw, "judge", false, "timeout or malformed");
				return out(false);
			}
			if (!canSwitch(mode, p.to, "judge")) {
				rec(p.to, "judge", false, "would raise autonomy or not a flow mode");
				return out(false, NOT_YOURS);
			}
			const to = p.to as FlowMode;
			if (to === mode) return out(false);
			if ((blockedUntil.get(to) ?? 0) > now()) {
				rec(to, "judge", false, "no-repeat after override");
				return out(false);
			}
			if (now() - lastInferredAt < INFERRED_RATE_LIMIT_MS) {
				rec(to, "judge", false, "inferred rate limit");
				return out(false);
			}
			lastInferredAt = now();
			pending = { to, at: now() };
			rec(to, "judge", false, "asked");
			return out(false, question(to), true);
		},

		answer(text) {
			if (pending === null) return out(false);
			if (now() - pending.at > INFERRED_ASK_TIMEOUT_MS) return this.tick();
			if (/^\s*(yes|yeah|yep|do it|please)\b/i.test(text)) {
				const to = pending.to;
				// The ceiling check ran when the question was asked and mode cannot
				// have changed since without clearing pending; re-check anyway.
				if (!canSwitch(mode, to, "judge")) {
					pending = null;
					return out(false, NOT_YOURS);
				}
				const o = apply(to, "judge");
				return o;
			}
			// Declined: that is an override of the proposal.
			blockedUntil.set(pending.to, now() + OVERRIDE_NO_REPEAT_MS);
			rec(pending.to, "judge", false, "declined");
			pending = null;
			return out(false);
		},

		tick() {
			if (pending !== null && now() - pending.at > INFERRED_ASK_TIMEOUT_MS) {
				rec(pending.to, "judge", false, "no answer in 5 s");
				pending = null;
			}
			return out(false);
		},

		undo() {
			if (prior === null) return out(false);
			const to = prior;
			return apply(to, "user-command");
		},
	};
}

/** Per-tab controllers. A new session builds a fresh store, so every tab resets to Act. */
export function createFlowModeStore(now: () => number = Date.now) {
	const tabs = new Map<string, FlowModeController>();
	return {
		forTab(id: string): FlowModeController {
			let c = tabs.get(id);
			if (!c) {
				c = createFlowModeController(now);
				tabs.set(id, c);
			}
			return c;
		},
	};
}
