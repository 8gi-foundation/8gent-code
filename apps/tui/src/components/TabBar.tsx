/**
 * 8gent Code - Tab Bar Component
 *
 * Folder-style tabs with box-drawing frame.
 * Active tab is raised and connected to the content below.
 */

import React from "react";
import { Box, Text } from "ink";
import { MutedText } from "./primitives/index.js";
import { TAB_ICONS, type WorkspaceTab, type TabType } from "../hooks/useWorkspaceTabs.js";

interface TabBarProps {
  tabs: WorkspaceTab[];
  onSwitch: (tabId: string) => void;
}

function getTabIcon(type: TabType): string {
  const found = TAB_ICONS.find((i) => i.type === type);
  return found?.icon || ">>";
}

export function TabBar({ tabs, onSwitch }: TabBarProps) {
  if (tabs.length <= 1) return null;

  const visibleTabs = tabs.filter(t => t.type !== "kanban" || t.active);

  // Build the two rows as single strings for perfect alignment
  let topRow = "";
  let botRow = "";

  for (const tab of visibleTabs) {
    const icon = getTabIcon(tab.type);
    const badge = tab.badge && tab.badge > 0 ? ` (${tab.badge})` : "";
    const label = `${icon} ${tab.title}${badge}`;

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
        <Text color="cyan">{botRow}{"─".repeat(80)}</Text>
      </Box>
    </Box>
  );
}
