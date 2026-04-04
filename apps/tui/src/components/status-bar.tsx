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
import { Box, useStdout } from "ink";
import { AppText, MutedText, Label, Badge, StatusDot, ShortcutHint, Inline, Spacer } from './primitives/index.js';
import { formatTokens, formatDuration, truncate } from '../lib/index.js';
import { TUI_STATUS_COMPACT_BELOW } from '../lib/layout-breakpoints.js';
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

  // Auth status
  authStatus?: "unknown" | "anonymous" | "authenticated" | "error";
  authUser?: { displayName: string; plan: string } | null;

  // Voice status
  voiceState?: "idle" | "recording" | "transcribing" | "downloading" | "listening" | "thinking" | "speaking" | "stopping";
  voiceEnabled?: boolean;
  voiceChatActive?: boolean;
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
  authStatus,
  authUser,
  voiceState,
  voiceEnabled = false,
  voiceChatActive = false,
}: EnhancedStatusBarProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const barWidth = Math.max(24, columns - 4);
  const modelMax = Math.max(6, Math.min(28, Math.floor(barWidth * 0.2)));
  const branchMax = Math.max(6, Math.min(22, Math.floor(barWidth * 0.16)));
  const authNameMax = Math.max(6, Math.min(16, Math.floor(barWidth * 0.12)));
  const planVerbMax = Math.max(12, Math.floor(barWidth * 0.22));
  const displayModel = truncate(modelName, modelMax);
  const displayBranch = currentBranch ? truncate(currentBranch, branchMax) : null;

  const [elapsed, setElapsed] = useState("0:00");

  // Update elapsed time
  useEffect(() => {
    if (!startTime) return;

    const updateElapsed = () => {
      const diffMs = Date.now() - startTime.getTime();
      setElapsed(formatDuration(diffMs));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  // Calculate savings percentage if not provided
  const savings =
    savingsPercentage ?? (tokensTotal > 0 ? Math.round((tokensSaved / tokensTotal) * 100) : 0);

  const effectiveCompact = compact || columns < TUI_STATUS_COMPACT_BELOW;

  if (effectiveCompact) {
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

  const tokenMetaShort = truncate(
    `${elapsed} ${"\u00B7"} ${formatTokens(tokensSaved)} tok`,
    Math.max(8, Math.min(24, Math.floor(barWidth * 0.16)))
  );

  return (
    <Box
      borderStyle={showBorder ? "single" : undefined}
      borderColor="blue"
      paddingX={1}
      marginTop={1}
      width={barWidth}
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      alignItems="center"
    >
      {/* Left: model and agents (truncated model name) */}
      <Box flexShrink={0}>
        <Inline gap={1}>
          <ActiveIndicator active={true} />
          <ModelStatusItem name={displayModel} />
          <Separator />
          <AgentStatusItem running={runningAgents} total={totalAgents} />
        </Inline>
      </Box>

      {/* Center: plan, permissions */}
      <Box flexShrink={1} marginX={1} minWidth={0}>
        <Inline gap={1}>
          {planStatus !== "idle" && (
            <>
              <PlanStatusItem
                status={planStatus}
                completed={planStepsCompleted}
                total={planStepsTotal}
                showAnimatedVerb={showAnimations}
                verbMaxWidth={planVerbMax}
              />
              {(planStatus === "planning" || planStatus === "executing") && (
                <MutedText>
                  ({tokenMetaShort})
                </MutedText>
              )}
              <Separator />
            </>
          )}
          <PermissionStatusItem mode={permissionMode} />
          {adhdMode && (
            <>
              <Separator />
              <Label color="magenta">⚡ ADHD</Label>
            </>
          )}
        </Inline>
      </Box>

      {/* Right: savings, branch, auth, voice, time */}
      <Box flexShrink={0}>
        <Inline gap={1}>
          <TokenSavingsItem saved={tokensSaved} percentage={savings} barWidth={barWidth} />
          {displayBranch && (
            <>
              <Separator />
              <GitBranchItem branch={displayBranch} hasChanges={hasUncommittedChanges} />
            </>
          )}
          {authStatus && authStatus !== "unknown" && (
            <>
              <Separator />
              <AuthStatusItem status={authStatus} user={authUser} nameMax={authNameMax} />
            </>
          )}
          {voiceEnabled && (
            <>
              <Separator />
              <VoiceStatusItem state={voiceState || "idle"} />
            </>
          )}
          <Separator />
          <ElapsedTimeItem time={elapsed} />
        </Inline>
      </Box>
    </Box>
  );
}

// ============================================
// Enhanced Status Bar Sub-Components
// ============================================

function ActiveIndicator({ active }: { active: boolean }) {
  if (active) {
    return <AppText color="green">{"\u25B8\u25B8"}</AppText>;
  }
  return <MutedText>{"\u25B8\u25B8"}</MutedText>;
}

function Separator() {
  return (
    <MutedText>
      {" \u00B7 "}
    </MutedText>
  );
}

function ModelStatusItem({ name }: { name: string }) {
  return <AppText color="cyan">{name}</AppText>;
}

function AgentStatusItem({ running, total }: { running: number; total: number }) {
  return (
    <Inline gap={0}>
      <StatusDot status={running > 0 ? "info" : "idle"} />
      {running > 0 ? (
        <AppText color="magenta">
          {" "}{running}/{total} agents
        </AppText>
      ) : (
        <MutedText>
          {" "}{running}/{total} agents
        </MutedText>
      )}
    </Inline>
  );
}

function PermissionStatusItem({ mode }: { mode: EnhancedStatusBarProps["permissionMode"] }) {
  const configs = {
    full: { color: "red" as const, icon: "\u26A0", label: "full access" },
    ask: { color: "yellow" as const, icon: "\u2753", label: "ask (approve tools)" },
    restricted: { color: "green" as const, icon: "\u2713", label: "restricted" },
    sandbox: { color: "blue" as const, icon: "\u25A3", label: "sandbox" },
    infinite: { color: "magenta" as const, icon: "\u221E", label: "infinite (no gates)" },
  };

  const config = configs[mode || "ask"];

  // Read-only status: avoid bracket badges that read like clickable controls (DesignExcellence)
  return (
    <Inline gap={0}>
      <MutedText>perm </MutedText>
      <AppText color={config.color}>
        {config.icon} {config.label}
      </AppText>
    </Inline>
  );
}

function TokenSavingsItem({
  saved,
  percentage,
  barWidth,
}: {
  saved: number;
  percentage: number;
  barWidth: number;
}) {
  const savingsColor = percentage > 50 ? "green" : percentage > 20 ? "yellow" : "blue";
  const tokenBit = truncate(`(${formatTokens(saved)} tok)`, Math.max(6, Math.floor(barWidth * 0.14)));

  return (
    <Inline gap={0}>
      <AppText color="green">{"\u2193"} </AppText>
      <Label color={savingsColor}>
        {percentage}%
      </Label>
      <MutedText>
        {" "}{tokenBit}
      </MutedText>
    </Inline>
  );
}

function GitBranchItem({ branch, hasChanges }: { branch: string; hasChanges: boolean }) {
  return (
    <Inline gap={0}>
      <AppText color="yellow">{"\uE0A0"} {branch}</AppText>
      {hasChanges && <AppText color="red">*</AppText>}
    </Inline>
  );
}

function ElapsedTimeItem({ time }: { time: string }) {
  return (
    <MutedText>
      {"\u23F1"} {time}
    </MutedText>
  );
}

function AuthStatusItem({
  status,
  user,
  nameMax,
}: {
  status: string;
  user?: { displayName: string; plan: string } | null;
  nameMax: number;
}) {
  if (status === "authenticated" && user) {
    const short = truncate(user.displayName, nameMax);
    return (
      <Badge label={`\u2713 ${short}`} color="green" variant="outline" />
    );
  }
  return <MutedText>{"\u25CB"} Guest</MutedText>;
}

function VoiceStatusItem({ state }: { state: string }) {
  if (state === "listening") {
    return <Badge label={"\u25CF VOICE CHAT"} color="green" variant="outline" />;
  }
  if (state === "speaking") {
    return <Badge label={"\u266B SPEAKING"} color="blue" variant="outline" />;
  }
  if (state === "thinking") {
    return <Badge label={"\u2026 THINKING"} color="yellow" variant="outline" />;
  }
  if (state === "recording") {
    return <Badge label={"\u25CF REC"} color="red" variant="outline" />;
  }
  if (state === "transcribing") {
    return <Badge label={"\u2026 STT"} color="cyan" variant="outline" />;
  }
  return <MutedText>{"\u25CB"} Mic (^R)</MutedText>;
}

function PlanStatusItem({
  status,
  completed,
  total,
  showAnimatedVerb = true,
  verbMaxWidth,
}: {
  status: EnhancedStatusBarProps["planStatus"];
  completed: number;
  total: number;
  showAnimatedVerb?: boolean;
  verbMaxWidth?: number;
}) {
  const configs = {
    idle: { color: "blue" as const, icon: "\u25CB", label: "idle", verbType: null },
    planning: { color: "cyan" as const, icon: "\u25D4", label: "planning...", verbType: "planning" as StatusVerbType },
    executing: { color: "yellow" as const, icon: "\u25B6", label: `${completed}/${total}`, verbType: "executing" as StatusVerbType },
    completed: { color: "green" as const, icon: "\u2713", label: "ready (awaiting input)", verbType: null },
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
          maxWidth={verbMaxWidth}
        />
      )}
      {/* Read-only run state: not a button (DesignExcellence) */}
      {(!isActive || !showAnimatedVerb) && (
        <Inline gap={0}>
          <MutedText>run </MutedText>
          <AppText color={config.color}>
            {config.icon} {config.label}
          </AppText>
        </Inline>
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
  const { stdout } = useStdout();
  const cols = Math.max(24, (stdout?.columns ?? 80) - 4);
  const modelShort = truncate(modelName, Math.max(6, Math.min(24, Math.floor(cols * 0.28))));
  const branchShort = currentBranch ? truncate(currentBranch, Math.max(6, Math.min(18, Math.floor(cols * 0.22)))) : null;
  const showBranch = branchShort != null && cols >= 40;

  const permissionIcons = {
    full: { color: "red" as const, icon: "\u26A0" },
    ask: { color: "yellow" as const, icon: "?" },
    restricted: { color: "green" as const, icon: "\u2713" },
    sandbox: { color: "blue" as const, icon: "\u25A3" },
    infinite: { color: "magenta" as const, icon: "\u221E" },
  };

  const permConfig = permissionIcons[permissionMode || "ask"];

  return (
    <Inline paddingX={1} marginTop={1} gap={0} width={cols} flexShrink={0}>
      <MutedText>[</MutedText>
      <AppText color="cyan">{modelShort}</AppText>
      <MutedText>] </MutedText>

      <StatusDot status={runningAgents > 0 ? "info" : "idle"} />

      <MutedText> </MutedText>
      <AppText color={permConfig.color}>{permConfig.icon}</AppText>

      <MutedText> </MutedText>
      <AppText color="green">{savings}%</AppText>

      {showBranch && (
        <>
          <MutedText> </MutedText>
          <AppText color="yellow">{branchShort}</AppText>
        </>
      )}

      <MutedText> </MutedText>
      <MutedText>
        {elapsed}
      </MutedText>
    </Inline>
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
            <AppText color={currentMode.color}>
              {currentMode.icon} {currentMode.label}
            </AppText>
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
      <MutedText>Tokens: </MutedText>
      <Label color="green">
        {formattedValue}
      </Label>
      {isIncreasing && <AppText color="green"> {"\u2191"}</AppText>}
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
    <MutedText>
      {hints[currentHint]}
    </MutedText>
  );
}

// Compact status bar
export function CompactStatusBar({ tokensSaved }: StatusBarProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="blue"
      paddingX={1}
      marginTop={1}
      justifyContent="space-between"
    >
      <Inline gap={1}>
        <StatusDot status="success" />
        <AppText color="green">AST</AppText>
      </Inline>
      <Label color="green">
        {formatTokens(tokensSaved)} saved
      </Label>
      <ShortcutHint keys="^C" description="exit" />
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
        borderColor="blue"
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
              <MutedText>
                Response: <AppText color="yellow">{responseTime}ms</AppText>
              </MutedText>
            )}
            {contextSize !== undefined && (
              <MutedText>
                Context: <AppText color="cyan">{contextSize}</AppText>
              </MutedText>
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
    <Inline gap={1}>
      <MutedText>AST savings:</MutedText>
      <Label color="green">
        ~{savingsPercent}%
      </Label>
      <MutedText>
        ({formatTokens(tokensSaved)} vs ~{formatTokens(estimatedWithoutAST)} raw)
      </MutedText>
    </Inline>
  );
}

// ============================================
// Utility Functions
// ============================================
// formatTokens and formatDuration are now imported from '../lib/index.js'
