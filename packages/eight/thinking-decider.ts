/**
 * Per-turn thinking decider (#5040).
 *
 * Fast by default: every turn starts at "low" and steps up ONE level for each
 * signal that the turn is hard. No model is called; the same inputs always give
 * the same level. The next turn starts again from "low", so the step back down
 * after a hard turn needs no state of its own.
 *
 * The owner's setting wins. A fixed level is used as set, whatever the signals
 * say. A cap bounds only what the decider picks, so it never goes above it.
 *
 * "off" is never decided: it means the 8gent sends no thinking control at all
 * and the provider keeps its own default. Only the owner can pick it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { THINKING_SETTINGS, type ThinkingSetting } from "../providers/thinking-request";

/** Where every turn starts. */
export const BASE_LEVEL: ThinkingSetting = "low";

/** Distinct files in play (named in the ask, or touched this session) that count as many. */
export const MANY_FILES_THRESHOLD = 6;

/** Characters of pasted context (the ask itself) that count as long: about 2000 tokens. */
export const LONG_CONTEXT_CHARS = 8000;

/** Failed turns in a row, in this session, before the next turn steps up. */
export const REPEAT_FAILURE_THRESHOLD = 2;

/** The levels the decider moves between, lowest first. */
const LADDER: readonly ThinkingSetting[] = ["low", "medium", "high"];

export type ThinkingSignal =
	| "plan-or-design"
	| "explicit-request"
	| "repeat-failure"
	| "many-files"
	| "long-context";

export interface ThinkingDecisionInput {
	/** The owner's ask for this turn. */
	prompt: string;
	/** Distinct files in play: named in the ask plus touched earlier in the session. */
	filesInPlay?: number;
	/** Failed turns in a row in this session; a success resets it to 0. */
	failedTurnsInRow?: number;
	/** Owner setting: a level used as set. Overrides the signals and the cap. */
	fixed?: ThinkingSetting;
	/** Owner setting: the decider never goes above this level. */
	cap?: ThinkingSetting;
}

export interface ThinkingDecision {
	/** The level this turn uses. */
	level: ThinkingSetting;
	/** "fixed" when the owner set it, "auto" when the decider picked it. */
	source: "fixed" | "auto";
	/** The signals that fired, in the order they are checked. Empty for a fixed level. */
	signals: ThinkingSignal[];
	/** True when the cap held the level below what the signals asked for. */
	capped: boolean;
}

const PLAN_OR_DESIGN =
	/\b(architect(?:ure|ing)?|system design|design (?:a|an|the|how|this|that|our)\b|(?:make|write|draft|create|come up with) (?:a|an|the) (?:\w+ )?plan|plan (?:out|for|the|how)\b|roadmap|trade-?offs?)/i;

const EXPLICIT_REQUEST =
	/\b(think (?:really |very |extra )?(?:hard|harder|carefully|deeply)|think (?:it|this|that) through|ultra-?think)\b/i;

/** A path-like token: has a directory separator and a file extension. */
const PATH_TOKEN = /(?:[\w.@-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}\b/g;

/** Distinct file paths named in text. */
export function filesNamedIn(text: string): string[] {
	return [...new Set(text.match(PATH_TOKEN) ?? [])];
}

function rank(level: ThinkingSetting): number {
	return THINKING_SETTINGS.indexOf(level);
}

/** The signals a turn carries. Pure. */
export function thinkingSignals(input: ThinkingDecisionInput): ThinkingSignal[] {
	const out: ThinkingSignal[] = [];
	if (PLAN_OR_DESIGN.test(input.prompt)) out.push("plan-or-design");
	if (EXPLICIT_REQUEST.test(input.prompt)) out.push("explicit-request");
	if ((input.failedTurnsInRow ?? 0) >= REPEAT_FAILURE_THRESHOLD) out.push("repeat-failure");
	if ((input.filesInPlay ?? 0) >= MANY_FILES_THRESHOLD) out.push("many-files");
	if (input.prompt.length >= LONG_CONTEXT_CHARS) out.push("long-context");
	return out;
}

/** Decide the level for one turn. No model call, no I/O. */
export function decideThinking(input: ThinkingDecisionInput): ThinkingDecision {
	if (input.fixed !== undefined) {
		return { level: input.fixed, source: "fixed", signals: [], capped: false };
	}
	const signals = thinkingSignals(input);
	const wanted = LADDER[Math.min(signals.length, LADDER.length - 1)];
	const cap = input.cap;
	// A cap below "low" (off) is not a ceiling the ladder can sit under; the
	// decider holds at its base instead of sending nothing.
	const capped = cap !== undefined && rank(cap) < rank(wanted);
	const level = capped ? (rank(cap) < rank(BASE_LEVEL) ? BASE_LEVEL : cap) : wanted;
	return { level, source: "auto", signals, capped };
}

// ─── Owner setting ──────────────────────────────────────────────────────────

export interface ThinkingOwnerSetting {
	/** undefined = auto (the decider picks). */
	fixed?: ThinkingSetting;
	/** undefined = no cap. */
	cap?: ThinkingSetting;
}

const isSetting = (v: unknown): v is ThinkingSetting =>
	typeof v === "string" && (THINKING_SETTINGS as readonly string[]).includes(v);

/** Read the owner's `thinking` block from a parsed settings object. Bad values are ignored. */
export function ownerThinkingSetting(settings: unknown): ThinkingOwnerSetting {
	const block = (settings as { thinking?: { level?: unknown; cap?: unknown } } | null)?.thinking;
	if (!block || typeof block !== "object") return {};
	const out: ThinkingOwnerSetting = {};
	if (isSetting(block.level)) out.fixed = block.level;
	if (isSetting(block.cap)) out.cap = block.cap;
	return out;
}

/** The owner's setting from ~/.8gent/settings.json. Missing or unreadable file = auto, no cap. */
export function readOwnerThinkingSetting(
	file: string = path.join(resolveHome(), ".8gent", "settings.json"),
): ThinkingOwnerSetting {
	try {
		return ownerThinkingSetting(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		return {};
	}
}

/**
 * A short status-line label for the level a turn used: "think low",
 * "think high (set)", "think medium (capped)". A level the provider could not
 * take says so: "think high, not sent". Pure, for the TUI to print as is.
 */
export function thinkingStatusLabel(t: {
	level: ThinkingSetting;
	source: "fixed" | "auto";
	capped: boolean;
	applied: boolean | null;
}): string {
	const tag = t.source === "fixed" ? " (set)" : t.capped ? " (capped)" : "";
	// No provider has a control above its "high": max goes out as high, and says so.
	const asHigh = t.level === "max" && t.applied !== false ? ", sent as high" : "";
	return `think ${t.level}${tag}${asHigh}${t.applied === false ? ", not sent" : ""}`;
}
