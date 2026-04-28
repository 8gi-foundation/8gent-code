/**
 * 8gent Code - Tab Bar Component
 *
 * Folder-style tabs with box-drawing frame.
 * Active tab is raised and connected to the content below.
 */

import { Box, Text } from "ink";
import React from "react";
import { TAB_ICONS, type TabType, type WorkspaceTab } from "../hooks/useWorkspaceTabs.js";
import { MutedText } from "./primitives/index.js";

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
}

function getTabIcon(type: TabType): string {
	const found = TAB_ICONS.find((i) => i.type === type);
	return found?.icon || ">>";
}

export function TabBar({ tabs, onSwitch, isTabProcessing }: TabBarProps) {
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
		const label = `${icon} ${tab.title}${badge}${busy}`;

		if (tab.active) {
			topRow += `┌ ${label} ┐`;
			botRow += `┘${" ".repeat(label.length + 2)}└`;
		} else {
			topRow += ` ${label} `;
			botRow += `${"─".repeat(label.length + 2)}`;
		}
	}

	return (
		<Box flexDirection="column" marginBottom={0}>
			<Box>
				<Text color="cyan">{topRow}</Text>
				<Box flexGrow={1} />
				<MutedText>^T:new ^W:close</MutedText>
			</Box>
			<Box>
				<Text color="cyan">
					{botRow}
					{"─".repeat(80)}
				</Text>
			</Box>
		</Box>
	);
}
