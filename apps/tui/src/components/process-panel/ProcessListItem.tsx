import React from "react";
import { Box, Text } from "ink";
import type { TaskInfo } from "../../../../../packages/tools/background.js";
import { AppText, MutedText, StatusDot, Inline } from "../primitives/index.js";
import { formatDuration, formatBytes } from "../../lib/index.js";
import { truncate } from "../../lib/text.js";

function statusToDot(status: string): "success" | "error" | "warning" | "info" | "idle" {
  switch (status) {
    case "running": return "info";
    case "completed": return "success";
    case "failed": return "error";
    case "killed": return "warning";
    default: return "idle";
  }
}

interface ProcessListItemProps {
  task: TaskInfo;
  selected: boolean;
  maxWidth: number;
}

export function ProcessListItem({ task, selected, maxWidth }: ProcessListItemProps) {
  const cmdWidth = Math.max(8, maxWidth - 16);
  const cmd = truncate(task.command, cmdWidth);
  const duration = formatDuration(task.runtime);

  return (
    <Box paddingX={1}>
      <Inline gap={1}>
        <StatusDot status={statusToDot(task.status)} />
        {selected ? (
          <Text inverse bold>{` ${cmd} `}</Text>
        ) : (
          <AppText>{cmd}</AppText>
        )}
      </Inline>
      <Box flexGrow={1} />
      <MutedText>{duration}</MutedText>
    </Box>
  );
}
