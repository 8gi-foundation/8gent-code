/**
 * 8gent Code - Tab Bar Component
 *
 * Folder-style tabs with box-drawing frame.
 * Active tab is raised and connected to the content below.
 *
 * Pane grouping support: tabs in the same group share a visual container
 * and can be dragged between groups using Ctrl+G.
 *
 * Geometry (every cell is the same width on both rows, so the frame
 * always lines up):
 *
 *    >> Orchestrator   ┌ >> QA ┐  N: Notes
 *   ─────────────────  ┘       └  ──────────────────────────
 *
 * Inactive cell: " label " over "─" x (label + 2).
 * Active cell:   "┌ label ┐" over "┘" + spaces + "└".
 * A grabbed tab (drag mode) swaps its padding spaces for "[" and "]".
 */

import { Box, Text } from "ink";
import React from "react";
import type { PaneGroup } from "../hooks/usePaneGroups.js";
import { TAB_ICONS, type TabType, type WorkspaceTab } from "../hooks/useWorkspaceTabs.js";
import { padRight, truncate } from "../lib/text.js";
import { t } from "../theme.js";

// Strip external-AI-vendor names from existing-session tab titles at render
// time. Persisted sessions still carry the old "Claude Code" string; this
// rewrites them on the fly so we never expose vendor names to the user.
function sanitizeTabTitle(title: string): string {
	if (title === "Claude Code") return "Sparring";
	if (title.toLowerCase().includes("claude")) return "Peer";
	return title;
}

interface TabBarProps {
	tabs: WorkspaceTab[];
	onSwitch: (tabId: string) => void;
	/**
	 * Optional predicate. Returning true marks a tab as currently processing
	 * (in-flight agent.chat call). The tab gets a small inline pulse so the
	 * user can see at a glance which tabs are still working while they're
	 * looking at a different one.
	 */
	isTabProcessing?: (tabId: string) => boolean;
	/** Pane groups for showing tab groupings */
	groups?: PaneGroup[];
	/** Currently grabbed tab (in drag mode). Omitted or null = not dragging. */
	grabbedTabId?: string | null;
	/** Called when user presses Ctrl+G on a tab */
	onGrabTab?: (tabId: string) => void;
	/** Called when user presses Ctrl+G on a tab (drop) */
	onDropOntoTab?: (targetTabId: string) => void;
	/** Terminal width in columns. The bar never draws wider than this. */
	width?: number;
}

/** Fallback width when the caller does not pass the viewport. */
const DEFAULT_WIDTH = 80;
export const GRAB_HINT = "[G] drop on another tab to group | [Esc] cancel";
/** How to move between tabs. Shown at rest when the bar is wide enough for it. */
export const SWITCH_HINT = "Ctrl+1-9 jump | Shift+Tab cycle | Esc back to chat";
const SWITCH_HINT_MIN_WIDTH = 100;

function getTabIcon(type: TabType): string {
	const found = TAB_ICONS.find((i) => i.type === type);
	return found?.icon || ">>";
}

export interface TabCell {
	label: string;
	active: boolean;
	grabbed?: boolean;
}

/**
 * Build the two rows of the tab bar as plain strings. Pure, so the frame
 * geometry can be unit-tested. Both rows are exactly `width` columns.
 */
export function buildTabRows(
	cells: TabCell[],
	width: number,
	hint = "",
): { top: string; bottom: string } {
	const tops: string[] = [];
	const bottoms: string[] = [];
	for (const cell of cells) {
		const open = cell.grabbed ? "[" : " ";
		const close = cell.grabbed ? "]" : " ";
		if (cell.active) {
			tops.push(`┌${open}${cell.label}${close}┐`);
			bottoms.push(`┘${" ".repeat(cell.label.length + 2)}└`);
		} else {
			tops.push(`${open}${cell.label}${close}`);
			bottoms.push("─".repeat(cell.label.length + 2));
		}
	}
	const topCols = Math.max(0, width - hint.length);
	const top = padRight(truncate(tops.join(" "), topCols), topCols) + hint;
	const bottomRaw = bottoms.join("─");
	const bottom =
		bottomRaw.length >= width
			? bottomRaw.slice(0, width)
			: bottomRaw + "─".repeat(width - bottomRaw.length);
	return { top, bottom };
}

export function TabBar({
	tabs,
	onSwitch,
	isTabProcessing,
	groups = [],
	grabbedTabId = null,
	onGrabTab,
	onDropOntoTab,
	width = DEFAULT_WIDTH,
}: TabBarProps) {
	if (tabs.length <= 1) return null;

	const visibleTabs = tabs.filter((tab) => tab.type !== "kanban" || tab.active);
	const dragging = grabbedTabId !== null && grabbedTabId !== undefined;

	const cells: TabCell[] = visibleTabs.map((tab) => {
		const icon = getTabIcon(tab.type);
		const badge = tab.badge && tab.badge > 0 ? ` (${tab.badge})` : "";
		// Inline processing indicator: a single `*` next to the tab title when
		// that tab has an in-flight agent.chat() call. Picked `*` because it
		// is already used elsewhere in the app for the Ideas tab and renders
		// reliably in any TTY without color cues.
		const busy = isTabProcessing?.(tab.id) ? " *" : "";
		const grouped = groups.some((g) => g.tabIds.includes(tab.id)) ? " +" : "";
		return {
			label: `${icon} ${sanitizeTabTitle(tab.title)}${badge}${busy}${grouped}`,
			active: tab.active,
			grabbed: dragging && grabbedTabId === tab.id,
		};
	});

	const hint = dragging ? ` ${GRAB_HINT}` : width >= SWITCH_HINT_MIN_WIDTH ? ` ${SWITCH_HINT}` : "";
	const { top, bottom } = buildTabRows(cells, width, hint);
	const topTabs = hint ? top.slice(0, top.length - hint.length) : top;

	return (
		<Box flexDirection="column" width={width} overflow="hidden">
			<Box>
				<Text color={t.teal}>{topTabs}</Text>
				{hint ? (
					dragging ? (
						<Text color={t.orangeAlt}>{hint}</Text>
					) : (
						<Text dimColor>{hint}</Text>
					)
				) : null}
			</Box>
			<Box>
				<Text color={t.teal}>{bottom}</Text>
			</Box>
		</Box>
	);
}
