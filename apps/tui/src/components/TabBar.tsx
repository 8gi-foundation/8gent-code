/**
 * 8gent Code - Tab Bar Component
 *
 * Folder-style tabs with box-drawing frame.
 * Active tab is raised and connected to the content below.
 *
 * Pane grouping support: tabs in the same group share a visual container
 * and can be dragged between groups using Ctrl+G.
 */

import { Box, Text } from "ink";
import React from "react";
import {
	TAB_ICONS,
	type TabType,
	type WorkspaceTab,
} from "../hooks/useWorkspaceTabs.js";
import type { PaneGroup } from "../hooks/usePaneGroups.js";
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
	/** Currently grabbed tab (in drag mode) */
	grabbedTabId?: string | null;
	/** Called when user presses Ctrl+G on a tab */
	onGrabTab?: (tabId: string) => void;
	/** Called when user presses Ctrl+G on a tab (drop) */
	onDropOntoTab?: (targetTabId: string) => void;
}

function getTabIcon(type: TabType): string {
	const found = TAB_ICONS.find((i) => i.type === type);
	return found?.icon || ">>";
}

export function TabBar({
	tabs,
	onSwitch,
	isTabProcessing,
	groups = [],
	grabbedTabId,
	onGrabTab,
	onDropOntoTab,
}: TabBarProps) {
	if (tabs.length <= 1) return null;

	const visibleTabs = tabs.filter((t) => t.type !== "kanban" || t.active);

	// Build the two rows as single strings for perfect alignment
	let topRow = "";
	let botRow = "";

	for (const tab of visibleTabs) {
		const icon = getTabIcon(tab.type);
		const badge = tab.badge && tab.badge > 0 ? ` (${tab.badge})` : "";
		// Inline processing indicator: a single `*` next to the tab title when
		// that tab has an in-flight agent.chat() call. Picked `*` because it
		// is already used elsewhere in the app for the Ideas tab and renders
		// reliably in any TTY without color cues.
		const busy = isTabProcessing?.(tab.id) ? " *" : "";

		// Grab mode indicator: `[` prefix when tab is grabbed, `]` when target can receive drop
		const isGrabbed = grabbedTabId === tab.id;
		const canDrop = grabbedTabId !== null && !isGrabbed;
		const grabIndicator = isGrabbed ? "[" : canDrop ? "]" : "";

		const label = `${icon} ${sanitizeTabTitle(tab.title)}${badge}${busy}`;

		// Check if tab is in a group
		const group = groups.find((g) => g.tabIds.includes(tab.id));
		const groupMarker = group ? "+" : "";

		if (tab.active) {
			topRow += `${grabIndicator}┌ ${label} ${groupMarker}┐${grabIndicator === "[" ? "" : ""}`;
			botRow += `${canDrop ? "]" : " "}┘${" ".repeat(label.length + 4 + (group ? 1 : 0))}└${canDrop ? "[" : " "}`;
		} else {
			const grabPrefix = grabIndicator || " ";
			const grabSuffix = canDrop ? "]" : " ";
			topRow += `${grabPrefix} ${label} ${groupMarker} ${grabSuffix}`;
			botRow += `${"─".repeat(label.length + 6 + (group ? 1 : 0))}`;
		}
	}

	// Grab mode hint
	const grabHint =
		grabbedTabId !== null
			? ` [G] drop on another tab to group | [Esc] cancel`
			: "";

	return (
		<Box flexDirection="column" marginBottom={0}>
			<Box>
				<Text color={t.teal}>{topRow}</Text>
				<Box flexGrow={1} />
				{grabHint && <Text color={t.yellow}>{grabHint}</Text>}
			</Box>
			<Box>
				<Text color={t.teal}>
					{botRow}
					{"─".repeat(Math.max(0, 80 - grabHint.length))}
				</Text>
			</Box>
		</Box>
	);
}
