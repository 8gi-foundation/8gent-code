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

import type { PermissionMode } from "../../../../packages/permissions/permission-mode.js";
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
}

export const PERM_LOOK: Record<PermissionMode, ModeLook> = {
	plan: {
		name: "Plan",
		token: "steel",
		bold: false,
		line: "Plan: reads and plans, changes nothing",
	},
	ask: {
		name: "Ask",
		token: "textSecondary",
		bold: false,
		line: "Ask: asks before it runs a command",
	},
	guarded: {
		name: "Guarded",
		token: "green",
		bold: false,
		line: "Guarded: safe steps run, risky ones still ask",
	},
	infinite: {
		name: "Infinite",
		token: "orange",
		bold: true,
		line: `Infinite: runs everything, never asks. ${PERM_KEY} to leave`,
	},
};

export function permColour(mode: PermissionMode): string {
	return t[PERM_LOOK[mode].token];
}

/** The chat line for a switch: "Permissions: Guarded: safe steps run, ... (⇧Tab to change)". */
export function permSwitchLine(mode: PermissionMode): string {
	return `Permissions: ${PERM_LOOK[mode].line}${mode === "infinite" ? "" : ` (${PERM_KEY} to change)`}`;
}

/**
 * The permission-mode key: Shift+Tab (Ink sets key.tab and key.shift for the
 * terminal's ESC [ Z). Terminals send Ctrl+Shift+Tab as the same bytes unless
 * a keyboard protocol this TUI does not enable is on, so it cycles too.
 */
export function isPermissionCycleKey(key: { tab?: boolean; shift?: boolean }): boolean {
	return Boolean(key.tab && key.shift);
}
