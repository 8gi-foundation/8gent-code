import React from "react";
import { Box, Text } from "ink";
import {
  AppText,
  MutedText,
  Badge,
  Inline,
  Stack,
  StatusDot,
} from "../primitives/index.js";

export interface TaskCardProps {
  title: string;
  status: "queued" | "active" | "done" | "error";
  duration?: number;
  details?: string;
  expanded?: boolean;
  focused?: boolean;
}

const STATUS_ICONS: Record<TaskCardProps["status"], { icon: string; color: string }> = {
  queued: { icon: "\u25CB", color: "" },       // ○ dimColor handled via prop
  active: { icon: "\u25B6", color: "cyan" },   // ▶
  done:   { icon: "\u2713", color: "green" },   // ✓
  error:  { icon: "\u2717", color: "red" },     // ✗
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TaskCard({
  title,
  status,
  duration,
  details,
  expanded = false,
  focused = false,
}: TaskCardProps) {
  const { icon, color } = STATUS_ICONS[status];
  const isDim = status === "queued" || status === "done";

  return (
    <Box flexDirection="column">
      <Box>
        {/* Focus indicator */}
        <Text color="cyan">{focused ? "\u2502 " : "  "}</Text>

        {/* Status icon */}
        <Text color={color || undefined} dimColor={status === "queued"}>
          {icon}{" "}
        </Text>

        {/* Title */}
        <Box flexGrow={1}>
          <Text bold={status === "active"} dimColor={status === "done"}>
            {title}
          </Text>
        </Box>

        {/* Duration, right-aligned */}
        {duration != null && (
          <Text dimColor>{formatDuration(duration)}</Text>
        )}
      </Box>

      {/* Expanded details */}
      {expanded && details && (
        <Box marginLeft={focused ? 4 : 4}>
          <Text dimColor>{details}</Text>
        </Box>
      )}
    </Box>
  );
}
