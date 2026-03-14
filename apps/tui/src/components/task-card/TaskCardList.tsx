import React, { useState, useEffect } from "react";
import { Box, useInput } from "ink";
import { TaskCard, type TaskCardProps } from "./TaskCard.js";
import { MutedText } from "../primitives/index.js";

export interface TaskItem {
  id: string;
  title: string;
  status: "queued" | "active" | "done" | "error";
  duration?: number;
  details?: string;
}

export interface TaskCardListProps {
  tasks: TaskItem[];
  maxHeight: number;
  focusable?: boolean;
}

const COLLAPSED_LINES = 1;
const EXPANDED_LINES = 4;

export function TaskCardList({
  tasks: rawTasks,
  maxHeight,
  focusable = true,
}: TaskCardListProps) {
  const tasks = rawTasks || [];
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Auto-scroll to first active task when tasks change
  useEffect(() => {
    if (tasks.length === 0) return;
    const activeIdx = tasks.findIndex((t) => t.status === "active");
    if (activeIdx !== -1) {
      setSelectedIndex(activeIdx);
    }
  }, [tasks]);

  // Clamp selectedIndex when tasks shrink
  useEffect(() => {
    if (tasks.length > 0 && selectedIndex >= tasks.length) {
      setSelectedIndex(tasks.length - 1);
    }
  }, [tasks.length, selectedIndex]);

  // Nothing to render
  if (tasks.length === 0) return null;

  useInput(
    (input, key) => {
      if (!focusable || tasks.length === 0) return;

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(tasks.length - 1, prev + 1));
      } else if (input === " ") {
        const task = tasks[selectedIndex];
        if (task) {
          setExpandedId((prev) => (prev === task.id ? null : task.id));
        }
      }
    },
    { isActive: focusable },
  );

  if (tasks.length === 0) return null;

  // Calculate which tasks are visible within maxHeight
  const getTaskHeight = (task: TaskItem): number =>
    task.id === expandedId && task.details
      ? EXPANDED_LINES
      : COLLAPSED_LINES;

  // Find scroll window that keeps selectedIndex visible
  let scrollStart = 0;
  let usedHeight = 0;
  let visibleCount = 0;

  // First, figure out total height if we show everything
  const heights = tasks.map(getTaskHeight);
  const totalHeight = heights.reduce((sum, h) => sum + h, 0);

  if (totalHeight <= maxHeight) {
    // Everything fits -- show all
    scrollStart = 0;
    visibleCount = tasks.length;
  } else {
    // Need to scroll. Start from selectedIndex and expand outward.
    // First ensure selectedIndex is in view by finding a window around it.
    scrollStart = selectedIndex;
    usedHeight = heights[selectedIndex]!;

    // Expand upward from selectedIndex
    let top = selectedIndex;
    let bottom = selectedIndex;

    // Try to include items above
    while (top > 0) {
      const candidateHeight = heights[top - 1]!;
      // Reserve 1 line for "N below" indicator if there are items below
      const reserveBelow = bottom < tasks.length - 1 ? 1 : 0;
      // Reserve 1 line for "N above" indicator if there would be items above
      const reserveAbove = top - 1 > 0 ? 1 : 0;
      if (usedHeight + candidateHeight + reserveBelow + reserveAbove > maxHeight) break;
      top--;
      usedHeight += candidateHeight;
    }

    // Try to include items below
    while (bottom < tasks.length - 1) {
      const candidateHeight = heights[bottom + 1]!;
      const reserveAbove = top > 0 ? 1 : 0;
      const reserveBelow = bottom + 1 < tasks.length - 1 ? 1 : 0;
      if (usedHeight + candidateHeight + reserveAbove + reserveBelow > maxHeight) break;
      bottom++;
      usedHeight += candidateHeight;
    }

    scrollStart = top;
    visibleCount = bottom - top + 1;
  }

  const aboveCount = scrollStart;
  const belowCount = tasks.length - (scrollStart + visibleCount);
  const visibleTasks = tasks.slice(scrollStart, scrollStart + visibleCount);

  return (
    <Box flexDirection="column" height={maxHeight} overflow="hidden">
      {aboveCount > 0 && (
        <MutedText>{`  \u25B2 ${aboveCount} above`}</MutedText>
      )}

      {visibleTasks.map((task, i) => {
        const globalIndex = scrollStart + i;
        return (
          <TaskCard
            key={task.id}
            title={task.title}
            status={task.status}
            duration={task.duration}
            details={task.details}
            expanded={expandedId === task.id}
            focused={focusable && globalIndex === selectedIndex}
          />
        );
      })}

      {belowCount > 0 && (
        <MutedText>{`  \u25BC ${belowCount} below`}</MutedText>
      )}
    </Box>
  );
}
