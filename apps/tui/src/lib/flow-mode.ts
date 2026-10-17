/**
 * Flow modes (L3): how I am working right now, one word above permission mode.
 *
 *   act    default. No-op over permissions, all four user modes.
 *   quiet  speaks only the floors (approvals, failures, refusals, warnings).
 *   think  think-aloud. Ceiling min(user, ask).
 *   listen ceiling plan. Selectable, but the notes store is deferred, so it
 *          is not in the cycle key.
 *
 * Built to spec section 4 and the 8SO review (R1-R9). The judge may only lower
 * the ceiling or ask. Raising, restore included, is user-only. Mode lives in a
 * closure in memory: never written to disk, settings or the daemon store, and
 * nothing in packages/permissions imports this file (tested).
 */

import {
	type PermissionMode,
	permissionRank,
	stricterMode,
} from "../../../../packages/permissions/permission-mode";
import { type Utterance, isAdmitted } from "./flow-capture";

export type FlowMode = "listen" | "think" | "quiet" | "act";
export const FLOW_MODES: readonly FlowMode[] = ["listen", "think", "quiet", "act"];
/** Cycle key order. Listen is deferred. */
export const CYCLE_MODES: readonly FlowMode[] = ["act", "think", "quiet"];
export const DEFAULT_FLOW_MODE: FlowMode = "act";

/** Set by the call site, never read from judge output. */
export type Origin = "user-key" | "user-slash" | "user-voice-confirmed" | "judge";

export const INFERRED_ASK_TIMEOUT_MS = 5_000;
export const JUDGE_TIMEOUT_MS = 1_500;
export const OVERRIDE_NO_REPEAT_MS = 10 * 60 * 1000;
export const INFERRED_RATE_LIMIT_MS = 5 * 60 * 1000;
export const RAISE_CONFIRM_MS = 10_000;
export const FLAP_WINDOW_MS = 60_000;
export const FLAP_MAX_LOWERINGS = 3;
const REASON_MAX = 80;

/** Flow ceiling over permission. null = the user's own mode. Order: plan < ask < guarded < infinite. */
const CEILING: Record<FlowMode, PermissionMode | null> = {
	listen: "plan",
	think: "ask",
	quiet: null,
	act: null,
};

/** Raw ceiling rank for the raise test. null (user's mode) is the top. */
function ceilingRank(m: FlowMode): number {
	const c = CEILING[m];
	return c === null ? Number.MAX_SAFE_INTEGER : permissionRank(c);
}

export function isFlowMode(v: unknown): v is FlowMode {
	return typeof v === "string" && (FLOW_MODES as readonly string[]).includes(v);
}

/** min(user, flow ceiling), recomputed on every call, never cached. Never raises. */
export function effectivePermission(user: PermissionMode, mode: FlowMode): PermissionMode {
	const c = CEILING[mode];
	return c === null ? user : stricterMode(user, c);
}

export function flowModeLabel(m: FlowMode): string {
	return { listen: "Listen", think: "Think", quiet: "Quiet", act: "Act" }[m];
}

export function nextFlowMode(m: FlowMode): FlowMode {
	const i = CYCLE_MODES.indexOf(m);
	return CYCLE_MODES[(i + 1) % CYCLE_MODES.length] as FlowMode;
}

/**
 * Pure gate. Judge origin may only go to a mode whose ceiling is equal or lower
 * than the current one, in raw terms and under the user's permission mode.
 * User origins always pass (they set the ceiling). A non-FlowMode target
 * fails for every origin.
 */
export function canSwitch(
	from: FlowMode,
	to: FlowMode,
	origin: Origin,
	userPerm: PermissionMode,
): boolean {
	if (!isFlowMode(to) || !isFlowMode(from)) return false;
	if (origin !== "judge") return true;
	return (
		ceilingRank(to) <= ceilingRank(from) &&
		permissionRank(effectivePermission(userPerm, to)) <=
			permissionRank(effectivePermission(userPerm, from))
	);
}

// ── Speech floors (R5) ───────────────────────────────────────────────

export type SpeechKind =
	| "reply"
	| "final-reply"
	| "ack"
	| "approval"
	| "failure"
	| "refusal"
	| "warning"
	| "mode-notice";

const FLOORS: readonly SpeechKind[] = ["approval", "failure", "refusal", "warning", "mode-notice"];

/** The floors speak in every mode. Above the floors: listen acks only, quiet nothing, act the final reply, think all. */
export function shouldSpeak(mode: FlowMode, kind: SpeechKind): boolean {
	if (FLOORS.includes(kind)) return true;
	if (mode === "listen") return kind === "ack";
	if (mode === "quiet") return false;
	if (mode === "act") return kind === "final-reply";
	return kind !== "ack";
}

/** Re-run at every tool boundary and for already-approved queued calls (R6). */
export type ToolKind = "read" | "write" | "shell";
export function flowToolVerdict(
	mode: FlowMode,
	userPerm: PermissionMode,
	kind: ToolKind,
): { allowed: boolean; reason?: string } {
	if (kind !== "read" && effectivePermission(userPerm, mode) === "plan") {
		return { allowed: false, reason: "Plan mode is read-only. Nothing was run." };
	}
	return { allowed: true };
}

// ── Fixed templates: nothing from the judge or the model is ever spoken ──

const NOTICE: Record<FlowMode, string> = {
	listen: "Listening.",
	think: "Thinking out loud.",
	quiet: "Going quiet.",
	act: "Back to work.",
};
const UNDO_HINT = "Undo: /mode <name> or the cycle key.";
const QUESTION: Record<FlowMode, string> = {
	listen: "Want me to just listen?",
	think: "Want to think out loud?",
	quiet: "Want me to go quiet?",
	act: "Want me to get on with it?",
};
export const NOT_YOURS = "Not switching, that is yours to set";
const CONFIRM_LINE = "Confirm on screen.";
const PAUSED_LINE = "Mode switching paused. Use /mode.";

// ── Phrases (R1.6) ───────────────────────────────────────────────────

const PHRASES: ReadonlyArray<[RegExp, FlowMode]> = [
	[/\b(go quiet|be quiet|quiet mode|stop talking)\b/, "quiet"],
	[/\b(think out loud|think aloud)\b/, "think"],
	[/\b(listen only|just listen)\b/, "listen"],
	[/\b(back to work|go ahead and do it|act mode)\b/, "act"],
];

type PhraseHit = { to: FlowMode; explicit: boolean };

/** Explicit only when the whole utterance, or the first clause of a short one, is the command. */
export function parsePhrase(text: string): PhraseHit | null {
	const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
	const clean = (s: string) =>
		s
			.replace(/^(ok|okay|hey|please)\b[ ,]*/, "")
			.replace(/[ ,.!]*(please)?[.! ]*$/, "")
			.trim();
	const clauses = norm
		.split(/[,.;!?]| and /)
		.map(clean)
		.filter(Boolean);
	const short = norm.split(" ").length <= 6;
	for (const [re, to] of PHRASES) {
		const m = re.exec(norm);
		if (!m) continue;
		const whole = clauses.length === 1 && clauses[0] === m[0];
		const first = short && clauses[0] === m[0];
		return { to, explicit: whole || first };
	}
	return null;
}

// ── Judge output: strict schema (R4) ─────────────────────────────────

export type JudgeParse =
	| { kind: "none" } // timeout, not JSON, not an object: silent
	| { kind: "invalid" } // an object that fails the schema: fixed refusal line
	| { kind: "ok"; to: FlowMode };

export function parseJudgeOutput(raw: unknown): JudgeParse {
	if (raw === null || raw === undefined || raw === "timeout") return { kind: "none" };
	let obj: unknown = raw;
	if (typeof raw === "string") {
		try {
			obj = JSON.parse(raw);
		} catch {
			return { kind: "none" };
		}
	}
	if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { kind: "none" };
	const o = obj as Record<string, unknown>;
	for (const k of Object.keys(o)) if (k !== "to" && k !== "reason") return { kind: "invalid" };
	if (!isFlowMode(o.to)) return { kind: "invalid" };
	if ("reason" in o && (typeof o.reason !== "string" || o.reason.length > REASON_MAX))
		return { kind: "invalid" };
	return { kind: "ok", to: o.to };
}

// ── Controller ───────────────────────────────────────────────────────

/** Signal class only. Transcript text is never logged. */
export type SignalClass =
	| "explicit"
	| "inferred"
	| "key"
	| "slash"
	| "confirm"
	| "yes"
	| "restore"
	| "untrusted"
	| "timeout"
	| "malformed"
	| "schema"
	| "stale"
	| "raise-refused"
	| "no-repeat"
	| "rate-limit"
	| "flap"
	| "declined"
	| "expired";

export interface LogEntry {
	at: number;
	from: FlowMode;
	to: FlowMode | null;
	origin: Origin | "none";
	signal: SignalClass;
	accepted: boolean;
}

export interface Outcome {
	changed: boolean;
	mode: FlowMode;
	/** One spoken line from a fixed template, or undefined for silence. */
	say?: string;
	/** On-screen line (undo hint, confirmation, pause notice). */
	screen?: string;
	asking?: boolean;
}

export interface JudgeTicket {
	readonly id: number;
	readonly utteranceId: number;
	readonly at: number;
}

export interface FlowModeController {
	readonly mode: FlowMode;
	readonly log: readonly LogEntry[];
	footer(): string;
	userSwitch(to: FlowMode, origin: "user-key" | "user-slash"): Outcome;
	/** Restore the snapshot taken at the last switch. User origin only. */
	restore(origin: Origin): Outcome;
	hear(u: Utterance): Outcome;
	beginJudge(u: Utterance): JudgeTicket | null;
	judgeResult(ticket: JudgeTicket, raw: unknown): Outcome;
	/** Whole-utterance yes or no for a pending proposal. Never approves a tool call. */
	answer(u: Utterance): Outcome;
	/** On-screen keypress confirming a pending voice raise. */
	confirmOnScreen(): Outcome;
	setApprovalPending(on: boolean): void;
	tick(): Outcome;
	/** New session, resume, restart, daemon reattach: Act, nothing remembered. */
	resetSession(): void;
}

export function createFlowModeController(
	now: () => number = Date.now,
	userPerm: () => PermissionMode = () => "ask",
): FlowModeController {
	let mode: FlowMode = DEFAULT_FLOW_MODE;
	let snapshot: FlowMode | null = null;
	let judgeSet: FlowMode | null = null;
	let pendingAsk: { to: FlowMode; utteranceId: number; at: number } | null = null;
	let pendingRaise: { to: FlowMode; at: number } | null = null;
	let ticketSeq = 0;
	let latestTicket = 0;
	let latestUtterance = 0;
	let lastInferredAt = Number.NEGATIVE_INFINITY;
	let approvalPending = false;
	let lowerings: number[] = [];
	const blockedUntil = new Map<FlowMode, number>();
	const log: LogEntry[] = [];

	const rec = (
		to: FlowMode | null,
		origin: Origin | "none",
		signal: SignalClass,
		accepted: boolean,
	) => log.push({ at: now(), from: mode, to, origin, signal, accepted });
	const out = (changed: boolean, say?: string, screen?: string, asking = false): Outcome => ({
		changed,
		mode,
		say,
		screen,
		asking,
	});

	function apply(to: FlowMode, origin: Origin, signal: SignalClass): Outcome {
		if (!canSwitch(mode, to, origin, userPerm())) {
			rec(to, origin, "raise-refused", false);
			return out(false, NOT_YOURS);
		}
		const t = now();
		const lowering = ceilingRank(to) < ceilingRank(mode);
		const viaVoiceOrJudge = origin === "judge" || origin === "user-voice-confirmed";
		if (lowering && viaVoiceOrJudge) {
			lowerings = lowerings.filter((x) => x > t - FLAP_WINDOW_MS);
			if (lowerings.length >= FLAP_MAX_LOWERINGS) {
				rec(to, origin, "flap", false);
				return out(false, undefined, PAUSED_LINE);
			}
			lowerings.push(t);
		}
		if (origin !== "judge" && judgeSet !== null && mode === judgeSet) {
			blockedUntil.set(judgeSet, t + OVERRIDE_NO_REPEAT_MS);
		}
		snapshot = mode; // exact prior flow mode, never a permission mode
		judgeSet = origin === "judge" ? to : null;
		rec(to, origin, signal, true);
		mode = to;
		pendingAsk = null;
		pendingRaise = null;
		return out(true, NOTICE[to], UNDO_HINT);
	}

	function ask(to: FlowMode, u: Utterance): Outcome {
		if (!canSwitch(mode, to, "judge", userPerm())) {
			rec(to, "judge", "raise-refused", false);
			return out(false, NOT_YOURS);
		}
		if (to === mode) return out(false);
		if ((blockedUntil.get(to) ?? 0) > now()) {
			rec(to, "judge", "no-repeat", false);
			return out(false);
		}
		if (now() - lastInferredAt < INFERRED_RATE_LIMIT_MS) {
			rec(to, "judge", "rate-limit", false);
			return out(false);
		}
		lastInferredAt = now();
		pendingAsk = { to, utteranceId: u.id, at: now() };
		rec(to, "judge", "inferred", false);
		return out(false, QUESTION[to], undefined, true);
	}

	return {
		get mode() {
			return mode;
		},
		get log() {
			return log;
		},
		footer: () => flowModeLabel(mode),

		userSwitch(to, origin) {
			if (!isFlowMode(to)) {
				rec(null, origin, "malformed", false);
				return out(false);
			}
			if (to === mode) return out(false);
			return apply(to, origin, origin === "user-key" ? "key" : "slash");
		},

		restore(origin) {
			if (origin === "judge" || snapshot === null) {
				rec(snapshot, origin, "restore", false);
				return out(false);
			}
			return apply(snapshot, origin, "restore");
		},

		hear(u) {
			if (!isAdmitted(u)) {
				rec(null, "none", "untrusted", false);
				return out(false);
			}
			latestUtterance = u.id;
			const hit = parsePhrase(u.text);
			if (hit === null || hit.to === mode) return out(false);
			if (!hit.explicit) return ask(hit.to, u);
			if (ceilingRank(hit.to) > ceilingRank(mode)) {
				// A raise (restore included) needs a keypress on screen, not just a voice.
				pendingRaise = { to: hit.to, at: now() };
				rec(hit.to, "user-voice-confirmed", "raise-refused", false);
				return out(false, CONFIRM_LINE, `Press Enter to switch to ${flowModeLabel(hit.to)}.`, true);
			}
			return apply(hit.to, "user-voice-confirmed", "explicit");
		},

		beginJudge(u) {
			if (!isAdmitted(u)) return null;
			latestUtterance = u.id;
			latestTicket = ++ticketSeq;
			return Object.freeze({ id: latestTicket, utteranceId: u.id, at: now() });
		},

		judgeResult(ticket, raw) {
			if (ticket.id !== latestTicket || ticket.utteranceId !== latestUtterance) {
				rec(null, "judge", "stale", false);
				return out(false);
			}
			if (now() - ticket.at > JUDGE_TIMEOUT_MS) {
				rec(null, "judge", "timeout", false);
				return out(false);
			}
			const p = parseJudgeOutput(raw);
			if (p.kind === "none") {
				rec(null, "judge", raw === "timeout" || raw == null ? "timeout" : "malformed", false);
				return out(false);
			}
			if (p.kind === "invalid") {
				rec(null, "judge", "schema", false);
				return out(false, NOT_YOURS);
			}
			if (p.to === mode) return out(false);
			return ask(p.to, { id: ticket.utteranceId, text: "", at: ticket.at });
		},

		answer(u) {
			if (!isAdmitted(u) || pendingAsk === null || approvalPending) {
				if (!isAdmitted(u)) rec(null, "none", "untrusted", false);
				return out(false);
			}
			if (now() - pendingAsk.at > INFERRED_ASK_TIMEOUT_MS) return this.tick();
			const t = u.text
				.toLowerCase()
				.replace(/[^\p{L}\s]/gu, "")
				.trim();
			if (t === "yes" || t === "yeah" || t === "yep" || t === "yes please") {
				return apply(pendingAsk.to, "judge", "yes"); // still checked as judge: a yes cannot raise
			}
			if (t === "no" || t === "nope" || t === "no thanks") {
				blockedUntil.set(pendingAsk.to, now() + OVERRIDE_NO_REPEAT_MS);
				rec(pendingAsk.to, "judge", "declined", false);
				pendingAsk = null;
			}
			return out(false);
		},

		confirmOnScreen() {
			if (pendingRaise === null || now() - pendingRaise.at > RAISE_CONFIRM_MS) {
				pendingRaise = null;
				return out(false);
			}
			return apply(pendingRaise.to, "user-voice-confirmed", "confirm");
		},

		setApprovalPending(on) {
			approvalPending = on;
		},

		tick() {
			if (pendingAsk !== null && now() - pendingAsk.at > INFERRED_ASK_TIMEOUT_MS) {
				rec(pendingAsk.to, "judge", "expired", false);
				pendingAsk = null;
			}
			if (pendingRaise !== null && now() - pendingRaise.at > RAISE_CONFIRM_MS) pendingRaise = null;
			return out(false);
		},

		resetSession() {
			mode = DEFAULT_FLOW_MODE;
			snapshot = null;
			judgeSet = null;
			pendingAsk = null;
			pendingRaise = null;
			lowerings = [];
			blockedUntil.clear();
			log.length = 0;
			lastInferredAt = Number.NEGATIVE_INFINITY;
			latestTicket = 0;
			latestUtterance = 0;
		},
	};
}

/** Per-tab controllers, in memory. A new store is a new session: every tab starts in Act. */
export function createFlowModeStore(
	now: () => number = Date.now,
	userPerm: () => PermissionMode = () => "ask",
) {
	const tabs = new Map<string, FlowModeController>();
	return {
		forTab(id: string): FlowModeController {
			let c = tabs.get(id);
			if (!c) {
				c = createFlowModeController(now, userPerm);
				tabs.set(id, c);
			}
			return c;
		},
		resetSession() {
			for (const c of tabs.values()) c.resetSession();
		},
	};
}
