/**
 * 8gent Code - Tab Bar Component
 *
 * Neumorphic-style folder tabs at the top of the app.
 * Active tab appears "raised" with box-drawing characters.
 * Inactive tabs appear "recessed" / dimmed.
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

  // Filter out kanban/music from display (they're overlays unless explicitly opened as tabs)
  const visibleTabs = tabs.filter(t => t.type !== "kanban" || t.active);

  return (
    <Box flexDirection="column" marginBottom={0}>
      {/* Tab row */}
      <Box paddingX={0}>
        {visibleTabs.map((tab, i) => {
          const icon = getTabIcon(tab.type);
          const isActive = tab.active;
          const label = `${icon} ${tab.title}`;
          const badge = tab.badge && tab.badge > 0 ? ` (${tab.badge})` : "";

          if (isActive) {
            // Active tab: raised folder tab with top border
            return (
              <Box key={tab.id} marginRight={0}>
                <Text color="cyan">╭─</Text>
                <Text bold color="cyan"> {label}{badge} </Text>
                <Text color="cyan">─╮</Text>
                <Text dimColor> </Text>
              </Box>
            );
          }

          // Inactive tab: flat, subtle
          return (
            <Box key={tab.id} marginRight={0}>
              <Text dimColor> {label}{badge} </Text>
              <Text dimColor>│</Text>
            </Box>
          );
        })}
        <Box flexGrow={1} />
        <MutedText> ^T:new ^W:close </MutedText>
      </Box>

      {/* Bottom border: active tab has a gap (like a real folder tab) */}
      <Box paddingX={0}>
        {visibleTabs.map((tab) => {
          const icon = getTabIcon(tab.type);
          const labelLen = icon.length + 1 + tab.title.length + (tab.badge && tab.badge > 0 ? ` (${tab.badge})`.length : 0);
          const isActive = tab.active;

          if (isActive) {
            // Gap in the bottom border where the active tab is
            return (
              <Box key={tab.id}>
                <Text color="cyan">╯</Text>
                <Text> {" ".repeat(labelLen)} </Text>
                <Text color="cyan">╰</Text>
                <Text dimColor>─</Text>
              </Box>
            );
          }

          // Continuous border under inactive tabs
          return (
            <Box key={tab.id}>
              <Text dimColor>{"─".repeat(labelLen + 2)}┴</Text>
            </Box>
          );
        })}
        <Box flexGrow={1}>
          <Text dimColor>{"─".repeat(40)}</Text>
        </Box>
      </Box>
    </Box>
  );
}
