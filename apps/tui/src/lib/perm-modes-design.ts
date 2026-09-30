/**
 * Permission modes: how they look (8DO spec, #3170).
 *
 * Presentation only: names, colour tokens, the key label and the one line a
 * switch writes to the chat. What each mode allows lives in
 * packages/permissions/permission-mode.ts.
 *
 * Cool to warm as risk rises: Plan steel, Guarded green, Infinite orange and
 * bold (so it reads without colour). Ask, the default, shows no segment.
 * Every token measured at 4.5:1 or better on both palettes' bg.
 */

import {
	type PermissionMode,
	type PermissionModeHolder,
	effectivePermissionMode,
	permissionRank,
} from "../../../../packages/permissions/permission-mode.js";
import { t } from "../theme.js";
import { unicodeRich } from "./term-caps.js";

/** Shift+Tab. `⇥` draws at a third of a cell in common mono fonts, so the word. */
export const PERM_KEY = unicodeRich() ? "⇧Tab" : "S-Tab";

interface ModeLook {
	name: string;
	token: "steel" | "textSecondary" | "green" | "orange";
	bold: boolean;
	/** The line a switch writes to the chat, so a screen reader hears it. */
	line: string;
	/** One-glyph tab tag below 120 columns. Ask shows none: it is the default. */
	initial: string;
	/**
	 * The footer toast after a switch. It uses the longest that fits:
	 * full (wide), short, tiny (fits beside mode and perm at 80 columns).
	 */
	toast: ToastForms;
}

export interface ToastForms {
	full: string;
	short: string;
	tiny: string;
}

export const PERM_LOOK: Record<PermissionMode, ModeLook> = {
	plan: {
		name: "Plan",
		token: "steel",
		bold: false,
		line: "Plan: reads and plans, changes nothing",
		initial: "P",
		toast: {
			full: "Plan: reads and plans, changes nothing",
			short: "reads only, changes nothing",
			tiny: "changes nothing",
		},
	},
	ask: {
		name: "Ask",
		token: "textSecondary",
		bold: false,
		line: "Ask: asks before it runs a command",
		initial: "A",
		toast: {
			full: "Ask: asks before it runs a command",
			short: "asks before commands",
			tiny: "asks to run",
		},
	},
	guarded: {
		name: "Guarded",
		token: "green",
		bold: false,
		line: "Guarded: safe steps run, risky ones still ask",
		initial: "G",
		toast: {
			full: "Guarded: safe steps run, risky ones still ask",
			short: "risky steps still ask",
			tiny: "risky ones ask",
		},
	},
	infinite: {
		name: "Infinite",
		token: "orange",
		bold: true,
		line: `Infinite: runs everything, never asks. ${PERM_KEY} to leave`,
		initial: "∞",
		toast: {
			full: `Infinite: runs everything, never asks. ${PERM_KEY} to leave`,
			short: `never asks. ${PERM_KEY} to leave`,
			tiny: "never asks",
		},
	},
};

export function permColour(mode: PermissionMode): string {
	return t[PERM_LOOK[mode].token];
}

/**
 * The chat line for a switch: "Permissions: Guarded: safe steps run, ...
 * (⇧Tab to change)". When a parent held the switch back, the line says so,
 * because the stream is what a screen reader reads.
 */
export function permSwitchLine(mode: PermissionMode, held = false): string {
	if (held) return `Permissions: ${permToastForms(mode, true).full}`;
	return `Permissions: ${PERM_LOOK[mode].line}${mode === "infinite" ? "" : ` (${PERM_KEY} to change)`}`;
}

// ── What a tab shows (#3174) ─────────────────────────────────────────

/** What the HUD shows for one agent: the mode it really has, and whether a parent holds it there. */
export interface PermView {
	/** The effective mode: always what is shown. */
	mode: PermissionMode;
	/** True when the mode set on this agent is more than its parent allows. */
	held: boolean;
}

/** The view of a holder: its effective mode, held when a parent clamps it below what was set. */
export function permView(holder: PermissionModeHolder, now: number = Date.now()): PermView {
	const mode = effectivePermissionMode(holder, now);
	return { mode, held: permissionRank(holder.mode) > permissionRank(mode) };
}

/** Tab tags switch from the word to one glyph below this many columns. */
export const TAB_TAG_WIDE_COLS = 120;

/**
 * The tag after a tab's title: " · Guarded" when wide, " G" when narrow,
 * nothing for Ask. Held: " · Plan, held" (wide). The glyph is always a
 * letter or symbol, so it reads under NO_COLOR; ASCII terminals get "I" for
 * Infinite and "-" for the dot.
 */
export function permTabTag(view: PermView, wide: boolean, rich: boolean = unicodeRich()): string {
	if (view.mode === "ask" && !view.held) return "";
	const look = PERM_LOOK[view.mode];
	if (!wide) return ` ${view.mode === "infinite" && !rich ? "I" : look.initial}`;
	return ` ${rich ? "·" : "-"} ${look.name}${view.held ? ", held" : ""}`;
}

/** The toast forms for a switch, or for a switch a parent held back. */
export function permToastForms(mode: PermissionMode, held = false): ToastForms {
	if (!held) return PERM_LOOK[mode].toast;
	const name = PERM_LOOK[mode].name;
	return {
		full: `Held at ${name}: the parent agent allows no more`,
		short: `held at ${name} by parent`,
		tiny: "parent's limit",
	};
}

/** How long the toast stays: 3 s, Infinite 5 s (James's default: the loud one stays longer). */
export const PERM_TOAST_MS = 3000;
export const PERM_TOAST_INFINITE_MS = 5000;
export function permToastMs(mode: PermissionMode): number {
	return mode === "infinite" ? PERM_TOAST_INFINITE_MS : PERM_TOAST_MS;
}

/** The footer note on a held segment: "(held by parent)", "(held)" below 120 columns. */
export function permHeldNote(columns: number): string {
	return columns >= TAB_TAG_WIDE_COLS ? "(held by parent)" : "(held)";
}

/**
 * Why the approval card came up, from the mode of the call that raised it.
 * Guarded runs safe steps on its own, so a card there means a risky step.
 */
export function approvalReason(mode: PermissionMode | undefined): string | undefined {
	return mode === "guarded" ? "risky step" : undefined;
}

/**
 * The permission-mode key: Shift+Tab (Ink sets key.tab and key.shift for the
 * terminal's ESC [ Z). Terminals send Ctrl+Shift+Tab as the same bytes unless
 * a keyboard protocol this TUI does not enable is on, so it cycles too.
 */
export function isPermissionCycleKey(key: { tab?: boolean; shift?: boolean }): boolean {
	return Boolean(key.tab && key.shift);
}
