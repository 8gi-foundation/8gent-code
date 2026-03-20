/**
 * ActivityMonitor - Real-time visualization of agent work
 *
 * Replaces the decorative ThinkingView with a live feed showing
 * what the agent is actually doing: URLs being fetched, files being
 * read, code being written, commands being run.
 *
 * Shows a contained "mini screen" with scrolling activity log,
 * making the agent's work visible and comprehensible.
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";

// ── Activity Types ──────────────────────────────────────────────────

interface ActivityEntry {
  id: string;
  tool: string;
  action: string;
  detail: string;
  icon: string;
  color: "cyan" | "green" | "yellow" | "magenta" | "blue" | "red";
  timestamp: number;
  done: boolean;
  durationMs?: number;
}

// ── Tool → Visual Mapping ───────────────────────────────────────────

function toolToActivity(toolName: string, args: Record<string, unknown>): {
  action: string;
  detail: string;
  icon: string;
  color: "cyan" | "green" | "yellow" | "magenta" | "blue" | "red";
} {
  switch (toolName) {
    case "web_search":
      return {
        action: "SEARCH",
        detail: String(args.query || "").slice(0, 60),
        icon: "🔍",
        color: "cyan",
      };
    case "web_fetch":
      return {
        action: "FETCH",
        detail: String(args.url || "").replace(/^https?:\/\//, "").slice(0, 50),
        icon: "🌐",
        color: "cyan",
      };
    case "read_file": {
      const path = String(args.path || "");
      const short = path.split("/").slice(-2).join("/");
      return {
        action: "READ",
        detail: short.slice(0, 50),
        icon: "📄",
        color: "blue",
      };
    }
    case "write_file": {
      const path = String(args.path || "");
      const short = path.split("/").slice(-2).join("/");
      return {
        action: "WRITE",
        detail: short.slice(0, 50),
        icon: "✏️",
        color: "green",
      };
    }
    case "edit_file": {
      const path = String(args.path || "");
      const short = path.split("/").slice(-2).join("/");
      return {
        action: "EDIT",
        detail: short.slice(0, 50),
        icon: "🔧",
        color: "yellow",
      };
    }
    case "run_command": {
      const cmd = String(args.command || "").slice(0, 60);
      return {
        action: "RUN",
        detail: cmd,
        icon: "▶",
        color: "magenta",
      };
    }
    case "search_text":
    case "search_symbols":
      return {
        action: "GREP",
        detail: String(args.query || args.pattern || "").slice(0, 50),
        icon: "🔎",
        color: "yellow",
      };
    case "list_files":
      return {
        action: "LIST",
        detail: String(args.path || ".").split("/").slice(-2).join("/"),
        icon: "📁",
        color: "blue",
      };
    case "git_commit":
      return {
        action: "GIT",
        detail: String(args.message || "commit").slice(0, 50),
        icon: "⎇",
        color: "green",
      };
    default:
      return {
        action: toolName.toUpperCase().slice(0, 8),
        detail: JSON.stringify(args).slice(0, 40),
        icon: "⚙",
        color: "cyan",
      };
  }
}

// ── Props ───────────────────────────────────────────────────────────

interface ActivityMonitorProps {
  /** Currently active tool name */
  activeTool: string | null;
  /** Step count */
  stepCount: number;
  /** Tool count */
  toolCount: number;
  /** Processing stage */
  processingStage: "planning" | "toolshed" | "executing" | "complete";
  /** Max visible entries */
  maxEntries?: number;
}

// ── Singleton activity log (persists across re-renders) ─────────────

const activityLog: ActivityEntry[] = [];
let logVersion = 0;

export function pushActivity(toolName: string, toolCallId: string, args: Record<string, unknown>): void {
  const { action, detail, icon, color } = toolToActivity(toolName, args);
  activityLog.push({
    id: toolCallId,
    tool: toolName,
    action,
    detail,
    icon,
    color,
    timestamp: Date.now(),
    done: false,
  });
  // Keep max 50 entries
  if (activityLog.length > 50) activityLog.shift();
  logVersion++;
}

export function completeActivity(toolCallId: string, success: boolean, durationMs: number): void {
  const entry = activityLog.find((e) => e.id === toolCallId);
  if (entry) {
    entry.done = true;
    entry.durationMs = durationMs;
    if (!success) entry.color = "red";
  }
  logVersion++;
}

export function clearActivity(): void {
  activityLog.length = 0;
  logVersion++;
}

// ── Component ───────────────────────────────────────────────────────

export function ActivityMonitor({
  activeTool,
  stepCount,
  toolCount,
  processingStage,
  maxEntries = 12,
}: ActivityMonitorProps) {
  const [tick, setTick] = useState(0);
  const [startTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [, forceRender] = useState(0);

  // Animation tick
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      setElapsed(Date.now() - startTime);
      forceRender((v) => v + 1); // Re-read activity log
    }, 300);
    return () => clearInterval(interval);
  }, [startTime]);

  const visibleEntries = activityLog.slice(-maxEntries);
  const dots = ".".repeat((tick % 3) + 1);

  // Format elapsed
  const secs = Math.floor(elapsed / 1000);
  const elapsedStr = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;

  // Scanning animation for the active entry
  const scanChars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"];
  const scanBar = scanChars[tick % scanChars.length];

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>┌─ Agent Activity </Text>
        <Text dimColor>step {stepCount} · {toolCount} tools · {elapsedStr}</Text>
        <Box flexGrow={1} />
        <Text color={processingStage === "executing" ? "green" : "yellow"}>
          {processingStage === "planning" ? "THINKING" : processingStage === "executing" ? "WORKING" : processingStage.toUpperCase()}
        </Text>
      </Box>

      {/* Activity feed — the "mini screen" */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
        flexGrow={1}
        minHeight={6}
      >
        {visibleEntries.length === 0 ? (
          <Box justifyContent="center" alignItems="center" flexGrow={1}>
            <Text dimColor>Thinking{dots}</Text>
          </Box>
        ) : (
          visibleEntries.map((entry, i) => {
            const isActive = !entry.done && i === visibleEntries.length - 1;
            const timeStr = entry.durationMs
              ? entry.durationMs < 1000
                ? `${entry.durationMs}ms`
                : `${(entry.durationMs / 1000).toFixed(1)}s`
              : "";

            return (
              <Box key={entry.id}>
                {/* Status indicator */}
                <Text color={entry.done ? (entry.color === "red" ? "red" : "green") : entry.color}>
                  {entry.done ? (entry.color === "red" ? "✗" : "✓") : isActive ? scanBar : "·"}{" "}
                </Text>

                {/* Action tag */}
                <Box width={7}>
                  <Text color={entry.color} bold={isActive}>
                    {entry.action}
                  </Text>
                </Box>

                {/* Detail */}
                <Box flexGrow={1}>
                  <Text dimColor={entry.done} bold={isActive}>
                    {entry.detail}
                  </Text>
                </Box>

                {/* Duration */}
                {timeStr && (
                  <Text dimColor> {timeStr}</Text>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* Footer — current action */}
      <Box marginTop={0}>
        <Text color="cyan" bold>└─ </Text>
        {activeTool ? (
          <Text bold>
            {toolToActivity(activeTool, {}).icon} {activeTool}{dots}
          </Text>
        ) : (
          <Text dimColor>
            Reasoning{dots}
          </Text>
        )}
      </Box>
    </Box>
  );
}
