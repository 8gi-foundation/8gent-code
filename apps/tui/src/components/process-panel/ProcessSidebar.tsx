import React from "react";
import { Box, useInput } from "ink";
import type { TaskInfo, TaskStatus } from "../../../../../packages/tools/background.js";
import { AppText, MutedText, Heading, Badge, Divider, Stack, Inline, ShortcutHint, Spacer } from "../primitives/index.js";
import { ProcessListItem } from "./ProcessListItem.js";

interface ProcessSidebarProps {
  tasks: TaskInfo[];
  selectedIndex: number;
  focused: boolean;
  taskCounts: Record<TaskStatus, number>;
  width: number;
  onNext: () => void;
  onPrev: () => void;
  onOpen: (taskId: string) => void;
  onKill: () => void;
  onUnfocus: () => void;
}

export function ProcessSidebar({
  tasks,
  selectedIndex,
  focused,
  taskCounts,
  width,
  onNext,
  onPrev,
  onOpen,
  onKill,
  onUnfocus,
}: ProcessSidebarProps) {
  // Local input handling for sidebar-specific keys
  useInput(
    (input, key) => {
      if (key.upArrow) { onPrev(); return; }
      if (key.downArrow) { onNext(); return; }
      if (key.return && tasks[selectedIndex]) {
        onOpen(tasks[selectedIndex].id);
        return;
      }
      if (key.escape) { onUnfocus(); return; }
      if (input === "k" && !key.ctrl && tasks[selectedIndex]?.status === "running") {
        onKill();
        return;
      }
    },
    { isActive: focused },
  );

  const runningCount = taskCounts.running;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={focused ? "cyan" : "blue"}
      flexShrink={0}
    >
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Heading>Processes</Heading>
        {runningCount > 0 && (
          <Badge label={`${runningCount} live`} color="green" />
        )}
      </Box>

      <Divider width={width - 2} />

      {/* Task list */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {tasks.length === 0 ? (
          <Box paddingX={1} paddingY={1}>
            <MutedText>No background processes</MutedText>
          </Box>
        ) : (
          tasks.map((task, i) => (
            <ProcessListItem
              key={task.id}
              task={task}
              selected={focused && i === selectedIndex}
              maxWidth={width - 4}
            />
          ))
        )}
      </Box>

      {/* Footer shortcuts */}
      {focused && tasks.length > 0 && (
        <>
          <Divider width={width - 2} />
          <Box paddingX={1} gap={1}>
            <ShortcutHint keys="↑↓" description="nav" />
            <ShortcutHint keys="⏎" description="view" />
            <ShortcutHint keys="k" description="kill" />
          </Box>
        </>
      )}
    </Box>
  );
}
