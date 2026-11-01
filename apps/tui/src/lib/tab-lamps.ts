/**
 * Tab lamps (#4928): one still mark per tab that says what the tab is doing
 * without opening it. Shape carries the meaning; colour only repeats it.
 *
 *   idle        ·   nothing running, nothing unread
 *   working     ◐   a turn is running (still, never a spinner)
 *   needs you   ▲   an approval card is waiting; the only orange on the bar
 *   done        ●   finished while you were on another tab
 *   failed      ✕   the turn ended in an error
 *
 * Priority when more than one applies: needs you, failed, working, done, idle.
 *
 * Motion follows lib/motion.ts: a change is marked once, resolves into
 * stillness, nothing loops, every burst ends inside MOTION_BUDGET_MS. The
 * frames here are data; TabBar plays them. Everything is pure.
 */

import { MOTION_BUDGET_MS, SETTLE_HOLD_MS } from "./motion.js";

export type LampState = "idle" | "working" | "needs" | "done" | "failed";

/** Colour intent, mapped to theme tokens by the bar. Colour is never the only signal. */
export type LampTone = "dim" | "secondary" | "orange" | "green" | "red";

export interface LampFrame {
	rich: string;
	ascii: string;
	tone: LampTone;
	bold: boolean;
	inverse: boolean;
	/** How long this frame holds. 0 on the resting frame, which stays. */
	ms: number;
}

/** What each tab reports to the bar. */
export interface LampInput {
	/** An approval card is waiting on this tab's turn. */
	needsYou: boolean;
	/** A turn is running. */
	processing: boolean;
	/** The last turn ended while the tab was in the background. */
	unread: "done" | "failed" | null;
}

export const LAMP_PRIORITY: readonly LampState[] = ["needs", "failed", "working", "done", "idle"];

export function deriveLamp(input: LampInput): LampState {
	if (input.needsYou) return "needs";
	if (input.unread === "failed") return "failed";
	if (input.processing) return "working";
	if (input.unread === "done") return "done";
	return "idle";
}

/** The most urgent of several lamps, for the "+N" overflow cell. */
export function worstLamp(states: readonly LampState[]): LampState {
	for (const s of LAMP_PRIORITY) if (states.includes(s)) return s;
	return "idle";
}

/** The word a screen reader gets for each state. */
export const LAMP_WORD: Record<LampState, string> = {
	idle: "idle",
	working: "working",
	needs: "needs you",
	done: "done",
	failed: "failed",
};

const frame = (
	rich: string,
	ascii: string,
	tone: LampTone,
	ms = 0,
	opts: { bold?: boolean; inverse?: boolean } = {},
): LampFrame => ({
	rich,
	ascii,
	tone,
	bold: opts.bold ?? false,
	inverse: opts.inverse ?? false,
	ms,
});

/**
 * The frame a state rests on. A tab you are looking at that needs you is
 * drawn inverse, so it cannot be missed beside its own card.
 */
export function restFrame(state: LampState, active = false): LampFrame {
	switch (state) {
		case "idle":
			return frame("·", ".", "dim");
		case "working":
			return frame("◐", "~", "secondary");
		case "needs":
			return frame("▲", "!", "orange", 0, { bold: true, inverse: active });
		case "done":
			return frame("●", "*", "green");
		case "failed":
			return frame("✕", "x", "red", 0, { bold: true });
	}
}

/** Visiting a done or failed tab: the lamp holds this long, then drops to idle. The tick-off. */
export const VISIT_HOLD_MS = SETTLE_HOLD_MS;

/**
 * The one-shot frames for a change, ending on the resting frame (ms 0).
 * Only a change that needs marking has lead-in frames; everything else is
 * the rest frame alone. The first frame already shows the new state's shape
 * for needs you and failed, so an ask is never a frame late.
 *
 * `visited`: the person just opened this tab, so a done or failed lamp holds
 * for VISIT_HOLD_MS before it clears.
 */
export function lampTransition(
	from: LampState,
	to: LampState,
	opts: { active?: boolean; visited?: boolean } = {},
): LampFrame[] {
	const rest = restFrame(to, opts.active ?? false);
	if (from === to) return [rest];
	if (opts.visited && (from === "done" || from === "failed")) {
		const held = restFrame(from);
		return [{ ...held, ms: VISIT_HOLD_MS }, rest];
	}
	switch (to) {
		case "working":
			return [frame("·", ".", "dim", 50), rest];
		case "needs":
			return [frame("▲", "!", "orange", 80, { bold: true, inverse: true }), rest];
		case "done":
			return [frame("◐", "~", "secondary", 70), frame("◑", "~", "secondary", 70), rest];
		case "failed":
			return [frame("✕", "x", "red", 60, { bold: true, inverse: true }), rest];
		default:
			return [rest];
	}
}

/** Total time before a transition comes to rest. */
export function transitionMs(frames: readonly LampFrame[]): number {
	return frames.reduce((sum, f) => sum + f.ms, 0);
}

export const LAMP_BURST_BUDGET_MS = MOTION_BUDGET_MS;

/** The glyph to draw. */
export const lampGlyph = (f: LampFrame, ascii: boolean): string => (ascii ? f.ascii : f.rich);

/**
 * The bar as text for a screen reader:
 * "Tabs: 1 Orchestrator working, 2 Engineer idle, 3 QA needs you, 4 Notes done".
 */
export function barAriaLabel(
	tabs: ReadonlyArray<{ title: string; state: LampState }>,
	hidden = 0,
): string {
	const parts = tabs.map((tb, i) => `${i + 1} ${tb.title} ${LAMP_WORD[tb.state]}`);
	if (hidden > 0) parts.push(`${hidden} more not shown`);
	return `Tabs: ${parts.join(", ")}`;
}

/**
 * The tab an asking call belongs to: the tab whose permission holder is the
 * call's holder or one of its ancestors (a child run by a tab's turn chains to
 * it). Undefined when the call is no tab's, so the caller falls back.
 */
export function tabOfHolder<H extends { parent?: H }>(
	holder: H | undefined,
	holders: ReadonlyMap<string, H>,
): string | undefined {
	for (let h = holder; h; h = h.parent) {
		for (const [id, held] of holders) if (held === h) return id;
	}
	return undefined;
}

/**
 * Which tab an approval card lights. A card from a tab's call carries its
 * holder: the tab that holder (or an ancestor) belongs to, and no tab at all
 * when it belongs to none. A card with no holder is a one-time question (yolo,
 * or the way back after a resume): it belongs to `noHolderTab`, the tab the
 * question is about. Nothing is ever guessed from which tabs are running.
 */
export function approvalTab<H extends { parent?: H }>(
	holder: H | undefined,
	holders: ReadonlyMap<string, H>,
	noHolderTab: string,
): string | undefined {
	return holder ? tabOfHolder(holder, holders) : noHolderTab;
}

/**
 * The unread map after a render. A tab whose turn ended while it was in the
 * background becomes done, or failed when its last word was an error; opening
 * a tab clears it (the bar holds the lamp 120 ms for the tick-off).
 */
export function nextUnread(
	unread: Readonly<Record<string, "done" | "failed">>,
	before: ReadonlySet<string>,
	now: ReadonlySet<string>,
	activeId: string,
	failed: (tabId: string) => boolean,
): Record<string, "done" | "failed"> {
	const out = { ...unread };
	delete out[activeId];
	for (const id of before) {
		if (now.has(id) || id === activeId) continue;
		out[id] = failed(id) ? "failed" : "done";
	}
	return out;
}
