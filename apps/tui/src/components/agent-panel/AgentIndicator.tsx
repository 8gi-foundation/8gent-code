/**
 * AgentIndicator — Shows which agent the user is currently addressing.
 * Appears in the prompt area. Shift+Tab cycles through agents.
 */

import React from "react";
import { Text, Box } from "ink";
import { Inline, MutedText, Badge } from "../primitives/index.js";

interface AgentIndicatorProps {
  agentName: string;
  agentColor: string;
  agentCount: number;
  chatMode: boolean;
}

export function AgentIndicator({ agentName, agentColor, agentCount, chatMode }: AgentIndicatorProps) {
  if (agentCount === 0 && !chatMode) return null;

  return (
    <Inline>
      {chatMode && (
        <Text color="yellow" dimColor> [chat] </Text>
      )}
      <Text color={agentColor as any} bold>
        {agentName}
      </Text>
      {agentCount > 0 && (
        <MutedText> ({agentCount + 1} agents)</MutedText>
      )}
      <Text color={agentColor as any}> {"\u276F"} </Text>
    </Inline>
  );
}
