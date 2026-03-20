/**
 * 8gent Code - Tab Bar Component
 *
 * Horizontal tab bar at the top of the app. Shows open workspace tabs
 * with keyboard navigation (Ctrl+T, Ctrl+W, Ctrl+1-9).
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
  if (tabs.length <= 1) {
    // Single tab — no need to show tab bar
    return null;
  }

  return (
    <Box paddingX={1} marginBottom={0}>
      {tabs.map((tab, i) => {
        const icon = getTabIcon(tab.type);
        const isActive = tab.active;
        const label = `${icon} ${tab.title}`;

        return (
          <Box key={tab.id} marginRight={1}>
            {isActive ? (
              <Text bold color="cyan" inverse>
                {" "}
                {label}
                {" "}
              </Text>
            ) : (
              <Text dimColor>
                {" "}
                {label}
                {" "}
              </Text>
            )}
            {i < tabs.length - 1 && <MutedText> </MutedText>}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <MutedText>^T:new ^W:close</MutedText>
    </Box>
  );
}
