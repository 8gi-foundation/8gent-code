/**
 * 8gent Code - Enhanced Status Bar Component
 *
 * Multiple colored status indicators like Claude Code:
 * Layout: [status1] . [status2] . [status3]
 *
 * Status items:
 * - Model name (cyan)
 * - Number of running agents (magenta)
 * - Permission mode (green/red)
 * - Token savings (green percentage)
 * - Current branch (yellow)
 * - Time elapsed (gray)
 *
 * Also includes animated variants from original implementation.
 */

import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { TokenSavingsBar, Sparkline } from "./progress-bar.js";
import { StatusIndicator } from "./animated-spinner.js";
import { RainbowBorder, AnimatedSeparator } from "./rainbow-border.js";
import { AnimatedStatusVerb, StatusVerbType } from "./status-verb.js";

// ============================================
// Types
// ============================================

export interface EnhancedStatusBarProps {
  // Model info
  modelName?: string;

  // Agent status
  runningAgents?: number;
  totalAgents?: number;

  // Permissions
  permissionMode?: "full" | "ask" | "restricted" | "sandbox" | "infinite";

  // Token efficiency
  tokensSaved?: number;
  tokensTotal?: number;
  savingsPercentage?: number;

  // Git info
  currentBranch?: string | null;
  hasUncommittedChanges?: boolean;

  // Session info
  startTime?: Date;

  // Planning status
  planStatus?: "idle" | "planning" | "executing" | "completed";
  planStepsCompleted?: number;
  planStepsTotal?: number;

  // Display options
  compact?: boolean;
  showBorder?: boolean;
  showAnimations?: boolean;

  // ADHD mode
  adhdMode?: boolean;
}

// Legacy interface for backward compatibility
interface StatusBarProps {
  tokensSaved: number;
  mode?: "ast" | "raw" | "hybrid";
  status?: "idle" | "thinking" | "executing" | "success" | "error";
  showAnimations?: boolean;
  soundEnabled?: boolean;
}

// ============================================
// Enhanced Status Bar (Claude Code Style)
// ============================================

export function EnhancedStatusBar({
  modelName = "8gent",
  runningAgents = 0,
  totalAgents = 1,
  permissionMode = "ask",
  tokensSaved = 0,
  tokensTotal = 0,
  savingsPercentage,
  currentBranch = null,
  hasUncommittedChanges = false,
  startTime,
  planStatus = "idle",
  planStepsCompleted = 0,
  planStepsTotal = 0,
  compact = false,
  showBorder = true,
  showAnimations = true,
  adhdMode = false,
}: EnhancedStatusBarProps) {
  const [elapsed, setElapsed] = useState("0:00");

  // Update elapsed time
  useEffect(() => {
    if (!startTime) return;

    const updateElapsed = () => {
      const diff = Math.floor((Date.now() - startTime.getTime()) / 1000);
      const mins = Math.floor(diff / 60);
      const secs = diff % 60;
      setElapsed(`${mins}:${secs.toString().padStart(2, "0")}`);
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  // Calculate savings percentage if not provided
  const savings =
    savingsPercentage ?? (tokensTotal > 0 ? Math.round((tokensSaved / tokensTotal) * 100) : 0);

  if (compact) {
    return (
      <ClaudeStyleCompactBar
        modelName={modelName}
        runningAgents={runningAgents}
        permissionMode={permissionMode}
        savings={savings}
        currentBranch={currentBranch}
        elapsed={elapsed}
      />
    );
  }

  return (
    <Box
      borderStyle={showBorder ? "single" : undefined}
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      justifyContent="space-between"
      flexWrap="wrap"
    >
      {/* Left section: Model & Agents */}
      <Box gap={1}>
        <ActiveIndicator active={true} />
        <ModelStatusItem name={modelName} />
        <Separator />
        <AgentStatusItem running={runningAgents} total={totalAgents} />
      </Box>

      {/* Center section: Plan status with animated verb & Permissions */}
      <Box gap={1}>
        {planStatus !== "idle" && (
          <>
            <PlanStatusItem
              status={planStatus}
              completed={planStepsCompleted}
              total={planStepsTotal}
              showAnimatedVerb={showAnimations}
            />
            {/* Show elapsed and tokens inline when processing */}
            {(planStatus === "planning" || planStatus === "executing") && (
              <Text color="gray" dimColor>
                ({elapsed} {"\u00B7"} {formatNumber(tokensSaved)} tokens)
              </Text>
            )}
            <Separator />
          </>
        )}
        <PermissionStatusItem mode={permissionMode} />
        {adhdMode && (
          <>
            <Separator />
            <Text color="magenta" bold>⚡ ADHD</Text>
          </>
        )}
      </Box>

      {/* Right section: Tokens, Branch, Time */}
      <Box gap={1}>
        <TokenSavingsItem saved={tokensSaved} percentage={savings} />
        {currentBranch && (
          <>
            <Separator />
            <GitBranchItem branch={currentBranch} hasChanges={hasUncommittedChanges} />
          </>
        )}
        <Separator />
        <ElapsedTimeItem time={elapsed} />
      </Box>
    </Box>
  );
}

// ============================================
// Enhanced Status Bar Sub-Components
// ============================================

function ActiveIndicator({ active }: { active: boolean }) {
  return (
    <Text color={active ? "green" : "gray"}>
      {"\u25B8\u25B8"}
    </Text>
  );
}

function Separator() {
  return (
    <Text color="gray" dimColor>
      {" \u00B7 "}
    </Text>
  );
}

function ModelStatusItem({ name }: { name: string }) {
  return <Text color="cyan">{name}</Text>;
}

function AgentStatusItem({ running, total }: { running: number; total: number }) {
  const color = running > 0 ? "magenta" : "gray";
  return (
    <Box>
      <Text color={color}>{running > 0 ? "\u25CF" : "\u25CB"} </Text>
      <Text color={color}>
        {running}/{total} agents
      </Text>
    </Box>
  );
}

function PermissionStatusItem({ mode }: { mode: EnhancedStatusBarProps["permissionMode"] }) {
  const configs = {
    full: { color: "red" as const, icon: "\u26A0", label: "Full Access" },
    ask: { color: "yellow" as const, icon: "\u2753", label: "Ask Mode" },
    restricted: { color: "green" as const, icon: "\u2713", label: "Restricted" },
    sandbox: { color: "blue" as const, icon: "\u25A3", label: "Sandbox" },
    infinite: { color: "magenta" as const, icon: "\u221E", label: "Infinite" },
  };

  const config = configs[mode || "ask"];

  return (
    <Box>
      <Text color={config.color}>{config.icon} </Text>
      <Text color={config.color}>{config.label}</Text>
    </Box>
  );
}

function TokenSavingsItem({ saved, percentage }: { saved: number; percentage: number }) {
  const formattedTokens = formatNumber(saved);
  const savingsColor = percentage > 50 ? "green" : percentage > 20 ? "yellow" : "gray";

  return (
    <Box>
      <Text color="green">{"\u2193"} </Text>
      <Text color={savingsColor} bold>
        {percentage}%
      </Text>
      <Text color="gray" dimColor>
        {" "}({formattedTokens} tokens)
      </Text>
    </Box>
  );
}

function GitBranchItem({ branch, hasChanges }: { branch: string; hasChanges: boolean }) {
  return (
    <Box>
      <Text color="yellow">{"\uE0A0"} </Text>
      <Text color="yellow">{branch}</Text>
      {hasChanges && <Text color="red">*</Text>}
    </Box>
  );
}

function ElapsedTimeItem({ time }: { time: string }) {
  return (
    <Text color="gray" dimColor>
      {"\u23F1"} {time}
    </Text>
  );
}

function PlanStatusItem({
  status,
  completed,
  total,
  showAnimatedVerb = true,
}: {
  status: EnhancedStatusBarProps["planStatus"];
  completed: number;
  total: number;
  showAnimatedVerb?: boolean;
}) {
  const configs = {
    idle: { color: "gray" as const, icon: "\u25CB", label: "Idle", verbType: null },
    planning: { color: "cyan" as const, icon: "\u25D4", label: "Planning...", verbType: "planning" as StatusVerbType },
    executing: { color: "yellow" as const, icon: "\u25B6", label: `${completed}/${total}`, verbType: "executing" as StatusVerbType },
    completed: { color: "green" as const, icon: "\u2713", label: "Done", verbType: null },
  };

  const config = configs[status || "idle"];
  const isActive = status === "planning" || status === "executing";

  return (
    <Box gap={1}>
      {/* Show animated verb when active */}
      {isActive && showAnimatedVerb && config.verbType && (
        <AnimatedStatusVerb
          type={config.verbType}
          showIcon={true}
          active={true}
        />
      )}
      {/* Show static status when not showing verb or when idle/completed */}
      {(!isActive || !showAnimatedVerb) && (
        <Box>
          <Text color={config.color}>{config.icon} </Text>
          <Text color={config.color}>{config.label}</Text>
        </Box>
      )}
    </Box>
  );
}

function ClaudeStyleCompactBar({
  modelName,
  runningAgents,
  permissionMode,
  savings,
  currentBranch,
  elapsed,
}: {
  modelName: string;
  runningAgents: number;
  permissionMode: EnhancedStatusBarProps["permissionMode"];
  savings: number;
  currentBranch: string | null;
  elapsed: string;
}) {
  const permissionIcons = {
    full: { color: "red" as const, icon: "\u26A0" },
    ask: { color: "yellow" as const, icon: "?" },
    restricted: { color: "green" as const, icon: "\u2713" },
    sandbox: { color: "blue" as const, icon: "\u25A3" },
    infinite: { color: "magenta" as const, icon: "\u221E" },
  };

  const permConfig = permissionIcons[permissionMode || "ask"];

  return (
    <Box paddingX={1} marginTop={1}>
      <Text color="gray">[</Text>
      <Text color="cyan">{modelName}</Text>
      <Text color="gray">] </Text>

      <Text color={runningAgents > 0 ? "magenta" : "gray"}>
        {runningAgents > 0 ? "\u25CF" : "\u25CB"}
      </Text>

      <Text color="gray"> </Text>
      <Text color={permConfig.color}>{permConfig.icon}</Text>

      <Text color="gray"> </Text>
      <Text color="green">{savings}%</Text>

      {currentBranch && (
        <>
          <Text color="gray"> </Text>
          <Text color="yellow">{currentBranch}</Text>
        </>
      )}

      <Text color="gray"> </Text>
      <Text color="gray" dimColor>
        {elapsed}
      </Text>
    </Box>
  );
}

// ============================================
// Legacy Animated Status Bar
// ============================================

export function StatusBar({
  tokensSaved,
  mode = "ast",
  status = "idle",
  showAnimations = true,
  soundEnabled = false,
}: StatusBarProps) {
  const [tokenHistory, setTokenHistory] = useState<number[]>([0]);
  const [tick, setTick] = useState(0);

  // Track token savings history for sparkline
  useEffect(() => {
    if (tokensSaved > tokenHistory[tokenHistory.length - 1]) {
      setTokenHistory((prev) => [...prev.slice(-19), tokensSaved]);
    }
  }, [tokensSaved]);

  // Tick animation for pulse effects
  useEffect(() => {
    if (!showAnimations) return;

    const interval = setInterval(() => {
      setTick((prev) => (prev + 1) % 100);
    }, 500);

    return () => clearInterval(interval);
  }, [showAnimations]);

  const modeConfig = {
    ast: { label: "AST-first", color: "green" as const, icon: "\u25C9" },
    raw: { label: "Raw mode", color: "yellow" as const, icon: "\u25CB" },
    hybrid: { label: "Hybrid", color: "cyan" as const, icon: "\u25CE" },
  };

  const currentMode = modeConfig[mode];

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Animated separator */}
      {showAnimations && <AnimatedSeparator width={60} speed={60} />}

      <RainbowBorder
        animate={showAnimations && status === "executing"}
        colorPalette={status === "executing" ? "neon" : "mono"}
        speed={100}
        borderStyle="single"
      >
        <Box justifyContent="space-between" width="100%">
          {/* Left: Mode indicator */}
          <Box gap={1}>
            <StatusIndicator status={status} />
            <Text color={currentMode.color}>
              {currentMode.icon} {currentMode.label}
            </Text>
          </Box>

          {/* Center: Token savings with sparkline */}
          <Box gap={1}>
            <TokenCounter value={tokensSaved} animate={showAnimations} />
            {showAnimations && tokenHistory.length > 3 && (
              <Sparkline values={tokenHistory} width={15} color="green" />
            )}
          </Box>

          {/* Right: Help text */}
          <Box>
            <HelpText animate={showAnimations} tick={tick} />
          </Box>
        </Box>
      </RainbowBorder>
    </Box>
  );
}

// Animated token counter
interface TokenCounterProps {
  value: number;
  animate?: boolean;
}

function TokenCounter({ value, animate = true }: TokenCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    if (!animate) {
      setDisplayValue(value);
      return;
    }

    if (displayValue === value) return;

    const diff = value - displayValue;
    const step = Math.max(1, Math.ceil(Math.abs(diff) / 15));
    const direction = diff > 0 ? 1 : -1;

    const timeout = setTimeout(() => {
      setDisplayValue((prev) => {
        const next = prev + step * direction;
        if (direction > 0 && next >= value) return value;
        if (direction < 0 && next <= value) return value;
        return next;
      });
    }, 20);

    return () => clearTimeout(timeout);
  }, [value, displayValue, animate]);

  const formattedValue = displayValue.toLocaleString();
  const isIncreasing = displayValue < value;

  return (
    <Box>
      <Text color="gray">Tokens saved: </Text>
      <Text color="green" bold>
        {formattedValue}
      </Text>
      {isIncreasing && <Text color="green"> {"\u2191"}</Text>}
    </Box>
  );
}

// Animated help text
interface HelpTextProps {
  animate?: boolean;
  tick?: number;
}

function HelpText({ animate = true, tick = 0 }: HelpTextProps) {
  const hints = [
    "Ctrl+C to exit",
    "/help for commands",
    "Tab to autocomplete",
    "/kanban for board",
    "/predict for next steps",
  ];

  const [currentHint, setCurrentHint] = useState(0);

  useEffect(() => {
    if (!animate) return;

    const interval = setInterval(() => {
      setCurrentHint((prev) => (prev + 1) % hints.length);
    }, 5000);

    return () => clearInterval(interval);
  }, [animate]);

  return (
    <Text color="gray" dimColor>
      {hints[currentHint]}
    </Text>
  );
}

// Compact status bar
export function CompactStatusBar({ tokensSaved }: StatusBarProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
      justifyContent="space-between"
    >
      <Text color="green">{"\u25CF"} AST</Text>
      <Text color="green" bold>
        {tokensSaved.toLocaleString()} saved
      </Text>
      <Text color="gray">^C exit</Text>
    </Box>
  );
}

// Detailed status bar with more metrics
interface DetailedStatusBarProps extends StatusBarProps {
  responseTime?: number;
  contextSize?: number;
}

export function DetailedStatusBar({
  tokensSaved,
  mode = "ast",
  status = "idle",
  responseTime,
  contextSize,
  showAnimations = true,
}: DetailedStatusBarProps) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {showAnimations && <AnimatedSeparator width={70} />}

      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
      >
        {/* Top row */}
        <Box justifyContent="space-between">
          <Box gap={2}>
            <StatusIndicator status={status} label={mode} />
            <TokenCounter value={tokensSaved} animate={showAnimations} />
          </Box>

          <Box gap={2}>
            {responseTime !== undefined && (
              <Text color="gray">
                Response: <Text color="yellow">{responseTime}ms</Text>
              </Text>
            )}
            {contextSize !== undefined && (
              <Text color="gray">
                Context: <Text color="cyan">{contextSize}</Text>
              </Text>
            )}
          </Box>
        </Box>

        {/* Bottom row - savings percentage */}
        <Box marginTop={1}>
          <SavingsPercentage tokensSaved={tokensSaved} animate={showAnimations} />
        </Box>
      </Box>
    </Box>
  );
}

// Savings percentage visualization
function SavingsPercentage({
  tokensSaved,
  animate,
}: {
  tokensSaved: number;
  animate: boolean;
}) {
  // Assume average tokens without AST would be ~40% more
  const estimatedWithoutAST = Math.round(tokensSaved * 1.4);
  const savingsPercent = Math.round((tokensSaved / estimatedWithoutAST) * 100);

  return (
    <Box gap={1}>
      <Text color="gray">AST savings:</Text>
      <Text color="green" bold>
        ~{savingsPercent}%
      </Text>
      <Text color="gray">
        ({tokensSaved.toLocaleString()} vs ~{estimatedWithoutAST.toLocaleString()} raw)
      </Text>
    </Box>
  );
}

// ============================================
// Utility Functions
// ============================================

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K";
  }
  return num.toLocaleString();
}
