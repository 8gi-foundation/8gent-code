import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import type { TaskInfo, TaskOutput } from "../../../../../packages/tools/background.js";
import { AppText, MutedText, Heading, Badge, Label, Inline, Stack, Divider, ShortcutHint } from "../primitives/index.js";
import { formatDuration } from "../../lib/index.js";
import { truncate } from "../../lib/text.js";

function statusColor(status: string): "green" | "red" | "yellow" | "cyan" {
  switch (status) {
    case "running": return "cyan";
    case "completed": return "green";
    case "failed": return "red";
    case "killed": return "yellow";
    default: return "cyan";
  }
}

interface ProcessDetailViewProps {
  task: TaskInfo;
  output: TaskOutput | null;
  onClose: () => void;
  onKill: () => void;
  height: number;
}

export function ProcessDetailView({
  task,
  output,
  onClose,
  onKill,
  height,
}: ProcessDetailViewProps) {
  const lines = (output?.combined || "").split("\n");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevLineCount = useRef(lines.length);

  // Header takes ~6 lines, footer ~2
  const viewportHeight = Math.max(4, height - 8);

  // Auto-scroll when new output arrives
  useEffect(() => {
    if (autoScroll && lines.length > prevLineCount.current) {
      setScrollOffset(Math.max(0, lines.length - viewportHeight));
    }
    prevLineCount.current = lines.length;
  }, [lines.length, autoScroll, viewportHeight]);

  // Keyboard
  useInput(
    (input, key) => {
      if (key.escape) { onClose(); return; }
      if (key.upArrow) {
        setAutoScroll(false);
        setScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        const maxOffset = Math.max(0, lines.length - viewportHeight);
        setScrollOffset((prev) => {
          const next = Math.min(maxOffset, prev + 1);
          if (next >= maxOffset) setAutoScroll(true);
          return next;
        });
        return;
      }
      if (input === "G" || input === "g") {
        // Jump to bottom
        setScrollOffset(Math.max(0, lines.length - viewportHeight));
        setAutoScroll(true);
        return;
      }
      if (input === "k" && !key.ctrl && task.status === "running") {
        onKill();
        return;
      }
    },
    { isActive: true },
  );

  const visibleLines = lines.slice(scrollOffset, scrollOffset + viewportHeight);
  const atBottom = scrollOffset >= lines.length - viewportHeight;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={1}
      >
        <Inline gap={2}>
          <Heading>{truncate(task.command, 50)}</Heading>
          <Badge label={task.status} color={statusColor(task.status)} />
        </Inline>
        <Inline gap={2}>
          <MutedText>Runtime: <AppText color="cyan">{formatDuration(task.runtime)}</AppText></MutedText>
          <MutedText>Exit: <AppText color={task.exitCode === 0 ? "green" : task.exitCode !== null ? "red" : "cyan"}>{task.exitCode ?? "—"}</AppText></MutedText>
          <MutedText>Lines: <AppText color="cyan">{lines.length}</AppText></MutedText>
          {!atBottom && <MutedText color="yellow">↑ scrolled</MutedText>}
        </Inline>
      </Box>

      {/* Output */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {visibleLines.length === 0 ? (
          <MutedText>Waiting for output...</MutedText>
        ) : (
          visibleLines.map((line, i) => (
            <Text key={scrollOffset + i} wrap="truncate">{line}</Text>
          ))
        )}
      </Box>

      {/* Footer */}
      <Divider />
      <Box paddingX={1} gap={2}>
        <ShortcutHint keys="Esc" description="back" />
        <ShortcutHint keys="↑↓" description="scroll" />
        <ShortcutHint keys="G" description="bottom" />
        {task.status === "running" && (
          <ShortcutHint keys="k" description="kill" />
        )}
      </Box>
    </Box>
  );
}
