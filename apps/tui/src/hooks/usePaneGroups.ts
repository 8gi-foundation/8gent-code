/**
 * 8gent Code - Pane Groups Hook
 *
 * Keyboard-driven pane grouping: like browser tab groups.
 * - Ctrl+G on pane A "grabs" it (puts in drag mode)
 * - Navigate to pane B
 * - Ctrl+G on pane B "drops" - creates a tab group
 *
 * In the TUI, "panes" are conceptual regions (sidebar, main content, etc.)
 * This hook manages grouping state that the renderer uses to show tabs
 * as grouped.
 */

import { useCallback, useState } from "react";
import type { WorkspaceTab } from "./useWorkspaceTabs.js";

// A pane group - tabs that are visually grouped together
export interface PaneGroup {
	id: string;
	tabIds: string[]; // Tab IDs in this group
	activeTabId: string; // Currently visible tab in the group
}

// State for pane grouping
export interface PaneGroupState {
	groups: PaneGroup[];
	grabbedTabId: string | null; // Tab being "dragged"
	grabbedFromGroup: string | null; // Which group it came from
}

const MAX_GROUP_SIZE = 10;

export function usePaneGroups() {
	const [state, setState] = useState<PaneGroupState>({
		groups: [],
		grabbedTabId: null,
		grabbedFromGroup: null,
	});

	// Grab a tab (Ctrl+G pressed on a tab)
	const grabTab = useCallback((tabId: string) => {
		setState((prev) => ({
			...prev,
			grabbedTabId: tabId,
			// Find which group this tab is in
			grabbedFromGroup: prev.groups.find((g) => g.tabIds.includes(tabId))?.id || null,
		}));
	}, []);

	// Drop onto a target tab (Ctrl+G pressed on another tab while holding)
	const dropOntoTab = useCallback(
		(targetTabId: string, tabs: WorkspaceTab[], switchToTab: (id: string) => void) => {
			setState((prev) => {
				if (!prev.grabbedTabId) return prev;
				if (prev.grabbedTabId === targetTabId) {
					// Same tab - cancel grab
					return { ...prev, grabbedTabId: null, grabbedFromGroup: null };
				}

				const grabbedId = prev.grabbedTabId;
				const fromGroupId = prev.grabbedFromGroup;
				const toGroup = prev.groups.find((g) => g.tabIds.includes(targetTabId));

				// Case 1: Dropping into an existing group
				if (toGroup) {
					// Check size limit
					if (toGroup.tabIds.length >= MAX_GROUP_SIZE) {
						return prev; // Group full, ignore
					}

					const newGroups = prev.groups.map((g) => {
						if (g.id === toGroup.id) {
							return {
								...g,
								tabIds: [...g.tabIds, grabbedId],
								activeTabId: grabbedId, // New tab becomes active
							};
						}
						// Remove from old group if existed
						if (fromGroupId && g.id === fromGroupId) {
							return {
								...g,
								tabIds: g.tabIds.filter((id) => id !== grabbedId),
							};
						}
						return g;
					}).filter((g) => g.tabIds.length > 0); // Remove empty groups

					// Switch to the dropped tab
					switchToTab(grabbedId);

					return {
						groups: newGroups,
						grabbedTabId: null,
						grabbedFromGroup: null,
					};
				}

				// Case 2: Creating a new group from two tabs
				const newGroupId = `group-${Date.now()}`;
				let newGroups = [...prev.groups];

				// Remove grabbed tab from old group if existed
				if (fromGroupId) {
					newGroups = newGroups.map((g) => {
						if (g.id === fromGroupId) {
							return { ...g, tabIds: g.tabIds.filter((id) => id !== grabbedId) };
						}
						return g;
					}).filter((g) => g.tabIds.length > 0);
				}

				// Add new group with both tabs
				const newGroup: PaneGroup = {
					id: newGroupId,
					tabIds: [targetTabId, grabbedId], // Target first (active), grabbed second
					activeTabId: grabbedId, // The dropped tab becomes active
				};
				newGroups.push(newGroup);

				// Switch to the dropped tab
				switchToTab(grabbedId);

				return {
					groups: newGroups,
					grabbedTabId: null,
					grabbedFromGroup: null,
				};
			});
		},
		[],
	);

	// Cancel the grab without dropping
	const cancelGrab = useCallback(() => {
		setState((prev) => ({
			...prev,
			grabbedTabId: null,
			grabbedFromGroup: null,
		}));
	}, []);

	// Remove a tab from its group
	const removeFromGroup = useCallback((tabId: string) => {
		setState((prev) => ({
			...prev,
			groups: prev.groups
				.map((g) => {
					if (g.tabIds.includes(tabId)) {
						return {
							...g,
							tabIds: g.tabIds.filter((id) => id !== tabId),
							activeTabId:
								g.activeTabId === tabId
									? g.tabIds.find((id) => id !== tabId) || g.activeTabId
									: g.activeTabId,
						};
					}
					return g;
				})
				.filter((g) => g.tabIds.length > 1), // Remove group if only 1 tab left
		}));
	}, []);

	// Get group for a tab
	const getGroupForTab = useCallback(
		(tabId: string): PaneGroup | null => {
			return state.groups.find((g) => g.tabIds.includes(tabId)) || null;
		},
		[state.groups],
	);

	// Check if a tab is grabbed
	const isGrabbed = useCallback(
		(tabId: string): boolean => {
			return state.grabbedTabId === tabId;
		},
		[state.grabbedTabId],
	);

	// Check if we're in grab mode
	const isGrabMode = useCallback((): boolean => {
		return state.grabbedTabId !== null;
	}, [state.grabbedTabId]);

	// Reorder tabs within a group
	const reorderInGroup = useCallback((groupId: string, tabIds: string[]) => {
		setState((prev) => ({
			...prev,
			groups: prev.groups.map((g) => {
				if (g.id === groupId) {
					return { ...g, tabIds };
				}
				return g;
			}),
		}));
	}, []);

	return {
		groups: state.groups,
		grabbedTabId: state.grabbedTabId,
		grabMode: isGrabMode(),
		grabTab,
		dropOntoTab,
		cancelGrab,
		removeFromGroup,
		getGroupForTab,
		isGrabbed,
		reorderInGroup,
	};
}
