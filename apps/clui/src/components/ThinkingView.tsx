/**
 * 8gent CLUI -- ThinkingView Component
 *
 * Animated visualization shown while the agent is processing.
 * Adapted from apps/tui/src/components/ThinkingView.tsx for React DOM.
 *
 * Features:
 * - Animated dot grid with ripple effect (CSS keyframes)
 * - Cycling status text with ellipsis animation
 * - Real-time step/tool counters and stage badge
 * - Elapsed timer
 * - Framer Motion enter/exit transitions
 * - Collapsible thinking text display
 *
 * Color rules: uses only CSS custom properties from tokens.css
 */

import React, { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ── Status Phases ──────────────────────────────────────────────────────

const STATUS_PHASES = [
  { text: "Planning approach", icon: "\u25C8" },
  { text: "Analyzing context", icon: "\u25C7" },
  { text: "Reading files", icon: "\u25C6" },
  { text: "Reasoning through options", icon: "\u25C8" },
  { text: "Synthesizing solution", icon: "\u25C7" },
  { text: "Generating response", icon: "\u25C6" },
  { text: "Refining output", icon: "\u25C8" },
  { text: "Almost there", icon: "\u25C7" },
];

// ── Dot Grid ───────────────────────────────────────────────────────────

const DOT_CHARS = ["\u00B7", "\u2218", "\u25CB", "\u25CC", "\u25C9", "\u25CF", "\u25C9", "\u25CC", "\u25CB", "\u2218"];
const GRID_COLS = 7;
const GRID_ROWS = 3;

function buildDotGrid(tick: number): string[][] {
  const grid: string[][] = [];
  const cx = Math.floor(GRID_COLS / 2);
  const cy = Math.floor(GRID_ROWS / 2);

  for (let r = 0; r < GRID_ROWS; r++) {
    const row: string[] = [];
    for (let c = 0; c < GRID_COLS; c++) {
      const dist = Math.abs(r - cy) + Math.abs(c - cx);
      const idx = (tick - dist + DOT_CHARS.length * 3) % DOT_CHARS.length;
      row.push(DOT_CHARS[idx]);
    }
    grid.push(row);
  }
  return grid;
}

// ── Elapsed Formatter ──────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

// ── Props ──────────────────────────────────────────────────────────────

interface ThinkingViewProps {
  /** Currently active tool name, if any */
  activeTool?: string | null;
  /** Number of agent steps completed so far */
  stepCount?: number;
  /** Number of tool calls made so far */
  toolCount?: number;
  /** Processing stage */
  processingStage?: "planning" | "toolshed" | "executing" | "complete";
  /** Optional current thinking text to display */
  thinkingText?: string | null;
  /** Whether the thinking text is collapsed */
  defaultCollapsed?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────

export function ThinkingView({
  activeTool,
  stepCount = 0,
  toolCount = 0,
  processingStage = "planning",
  thinkingText = null,
  defaultCollapsed = true,
}: ThinkingViewProps) {
  const [tick, setTick] = useState(0);
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

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
  const statusText = activeTool ? `Using ${activeTool}` : phase.text;
  const statusIcon = activeTool ? "\u2699" : phase.icon;

  // Pulsing ellipsis
  const dots = ".".repeat((tick % 3) + 1);

  // Stage label and color
  const stageConfig: Record<string, { label: string; colorClass: string }> = {
    planning: { label: "PLANNING", colorClass: "text-accent" },
    toolshed: { label: "TOOLSHED", colorClass: "text-brand" },
    executing: { label: "EXECUTING", colorClass: "text-warning" },
    complete: { label: "DONE", colorClass: "text-success" },
  };
  const stage = stageConfig[processingStage] || stageConfig.planning;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="flex flex-col items-center justify-center py-6"
    >
      {/* Dot grid animation */}
      <div className="flex flex-col items-center mb-3 select-none">
        {grid.map((row, ri) => (
          <div key={ri} className="flex gap-1">
            {row.map((dot, ci) => (
              <span
                key={ci}
                className="text-accent text-sm leading-none"
                style={{
                  opacity: 0.4 + Math.sin((tick + ri + ci) * 0.3) * 0.4,
                  transition: "opacity 200ms ease",
                }}
              >
                {dot}
              </span>
            ))}
          </div>
        ))}
      </div>

      {/* Main status line */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-accent text-sm">{statusIcon}</span>
        <span className="text-text-primary text-sm font-bold">
          {statusText}
          <span className="text-muted">{dots}</span>
        </span>
      </div>

      {/* Real-time counters */}
      {(stepCount > 0 || toolCount > 0) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-3 mb-2 text-xs"
        >
          {stepCount > 0 && (
            <span className="text-muted">
              Steps: <span className="text-accent">{stepCount}</span>
            </span>
          )}
          {stepCount > 0 && toolCount > 0 && (
            <span className="text-muted">&middot;</span>
          )}
          {toolCount > 0 && (
            <span className="text-muted">
              Tools: <span className="text-accent">{toolCount}</span>
            </span>
          )}
          <span className="text-muted">&middot;</span>
          <span className={`font-bold ${stage.colorClass}`}>{stage.label}</span>
        </motion.div>
      )}

      {/* Elapsed time */}
      <div className="text-muted text-xs">
        Elapsed: {formatElapsed(elapsed)}
      </div>

      {/* Collapsible thinking text */}
      {thinkingText && (
        <div className="mt-3 w-full max-w-lg">
          <button
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="
              flex items-center gap-1 text-xs text-muted
              hover:text-accent transition-colors duration-150
            "
          >
            <span
              className="transition-transform duration-150"
              style={{ transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
            >
              &rsaquo;
            </span>
            <span>Reasoning</span>
          </button>

          <AnimatePresence>
            {!isCollapsed && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="mt-1 px-3 py-2 border-l-2 border-accent/30 text-xs text-text-secondary leading-relaxed max-h-32 overflow-y-auto">
                  {thinkingText}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}

export default ThinkingView;
