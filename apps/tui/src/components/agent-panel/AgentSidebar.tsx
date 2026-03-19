/**
 * AgentSidebar — Lists all active orchestrated agents with status.
 * Shown alongside the main chat when agents are running.
 */

import React from "react";
import { Box, Text } from "ink";
import { AppText, MutedText, Stack, Divider } from "../primitives/index.js";

interface AgentEntry {
  id: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  task: string;
  status: string;
  spawnedAt: Date;
}

interface AgentSidebarProps {
  agents: AgentEntry[];
  activeAgentId: string | null;
}

function formatElapsed(since: Date): string {
  const diff = Math.floor((Date.now() - since.getTime()) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  return `${Math.floor(diff / 3600)}h`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "spawning": return "...";
    case "running": return ">>>";
    case "paused": return "||";
    case "completed": return "OK";
    case "failed": return "XX";
    default: return "??";
  }
}

export function AgentSidebar({ agents, activeAgentId }: AgentSidebarProps) {
  if (agents.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      width={30}
      borderStyle="single"
      borderColor="blue"
      paddingX={1}
    >
      <Text color="blue" bold>
        Agents ({agents.length + 1})
      </Text>
      <Divider />

      {/* Orchestrator (always present) */}
      <Box>
        <Text color="cyan" bold={!activeAgentId}>
          {!activeAgentId ? ">" : " "} Eight (orchestrator)
        </Text>
      </Box>

      {/* Sub-agents */}
      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;
        return (
          <Box key={agent.id} flexDirection="column">
            <Text color={agent.color as any} bold={isActive}>
              {isActive ? ">" : " "} {agent.icon} {agent.name} ({agent.role})
            </Text>
            <MutedText>
              {"   "}{statusIcon(agent.status)} {agent.task.slice(0, 20)}
              {agent.task.length > 20 ? "..." : ""} {formatElapsed(agent.spawnedAt)}
            </MutedText>
          </Box>
        );
      })}
    </Box>
  );
}
