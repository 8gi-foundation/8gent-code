/**
 * ThinkingView - Animated visualization shown while the agent is processing
 *
 * Fills the empty space between sending a message and receiving a response
 * with animated status updates, a pulsing dot grid, and real-time tool info.
 */

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text } from "ink";

// ── Status Phases ──────────────────────────────────────────────────────

const STATUS_PHASES = [
  { text: "Planning approach", icon: "◈" },
  { text: "Analyzing context", icon: "◇" },
  { text: "Reading files", icon: "◆" },
  { text: "Reasoning through options", icon: "◈" },
  { text: "Synthesizing solution", icon: "◇" },
  { text: "Generating response", icon: "◆" },
  { text: "Refining output", icon: "◈" },
  { text: "Almost there", icon: "◇" },
];

// ── Dot Grid Animation ─────────────────────────────────────────────────

const DOT_CHARS = ["·", "∘", "○", "◌", "◉", "●", "◉", "◌", "○", "∘"];
const GRID_COLS = 7;
const GRID_ROWS = 3;

function buildDotGrid(tick: number): string[][] {
  const grid: string[][] = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    const row: string[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      // Ripple effect: offset based on distance from center
      const cx = Math.floor(GRID_COLS / 2);
      const cy = Math.floor(GRID_ROWS / 2);
      const dist = Math.abs(r - cy) + Math.abs(c - cx);
      const idx = (tick - dist + DOT_CHARS.length * 3) % DOT_CHARS.length;
      row.push(DOT_CHARS[idx]);
    }
    grid.push(row);
  }
  return grid;
}

// ── Elapsed Timer ───────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

// ── Props ───────────────────────────────────────────────────────────────

interface ThinkingViewProps {
  /** Currently active tool name, if any */
  activeTool?: string | null;
  /** Number of agent steps completed so far */
  stepCount?: number;
  /** Number of tool calls made so far */
  toolCount?: number;
  /** Processing stage from the app */
  processingStage?: "planning" | "toolshed" | "executing" | "complete";
}

// ── Component ───────────────────────────────────────────────────────────

export function ThinkingView({
  activeTool,
  stepCount = 0,
  toolCount = 0,
  processingStage = "planning",
}: ThinkingViewProps) {
  const [tick, setTick] = useState(0);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);

  // Fast tick for dot animation (~200ms)
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      setElapsed(Date.now() - startTime);
    }, 200);
    return () => clearInterval(interval);
  }, [startTime]);

  // Slower cycle for status text (~2.5s)
  useEffect(() => {
    const interval = setInterval(() => {
      setPhaseIndex((i) => (i + 1) % STATUS_PHASES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  const grid = useMemo(() => buildDotGrid(tick), [tick]);
  const phase = STATUS_PHASES[phaseIndex];

  // Override status text when we have real tool info
  const statusText = activeTool
    ? `Using ${activeTool}`
    : phase.text;

  const statusIcon = activeTool ? "⚙" : phase.icon;

  // Pulsing ellipsis
  const dots = ".".repeat((tick % 3) + 1);

  // Stage label
  const stageLabel =
    processingStage === "planning"
      ? "PLANNING"
      : processingStage === "toolshed"
        ? "TOOLSHED"
        : processingStage === "executing"
          ? "EXECUTING"
          : "DONE";

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={1}>

      {/* Dot grid animation */}
      <Box flexDirection="column" alignItems="center" marginBottom={1}>
        {grid.map((row, ri) => (
          <Box key={ri}>
            {row.map((dot, ci) => (
              <Text key={ci} color="cyan">
                {dot}{" "}
              </Text>
            ))}
          </Box>
        ))}
      </Box>

      {/* Main status line */}
      <Box marginBottom={1}>
        <Text color="cyan">{statusIcon} </Text>
        <Text bold>{statusText}{dots}</Text>
      </Box>

      {/* Real-time counters */}
      {(stepCount > 0 || toolCount > 0) && (
        <Box marginBottom={1}>
          <Text dimColor>
            Steps: </Text>
          <Text color="cyan">{stepCount}</Text>
          <Text dimColor>  ·  Tools: </Text>
          <Text color="cyan">{toolCount}</Text>
          <Text dimColor>  ·  </Text>
          <Text color="magenta">{stageLabel}</Text>
        </Box>
      )}

      {/* Elapsed time */}
      <Box>
        <Text dimColor>Elapsed: {formatElapsed(elapsed)}</Text>
      </Box>
    </Box>
  );
}

export default ThinkingView;
