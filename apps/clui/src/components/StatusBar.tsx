/**
 * 8gent CLUI -- Status Bar Component
 *
 * Adapted from apps/tui/src/components/status-bar.tsx for React DOM.
 *
 * Layout: [model] . [agents] . [permission] . [tokens] . [branch] . [time]
 *
 * Uses CSS custom properties for all colors -- no hardcoded values.
 */

import React, { useEffect, useState } from "react";
import { useSessionStore } from "../stores/session-store";

// ── Main Status Bar ──────────────────────────────────────────────────

export function StatusBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const session = activeId ? sessions[activeId] : null;

  const activeSessions = Object.values(sessions).filter(
    (s) => s.status === "processing",
  ).length;
  const totalSessions = Object.keys(sessions).length;

  return (
    <div
      className="
        flex items-center justify-between
        h-7 px-3
        bg-surface-secondary border-t border-subtle
        text-xs select-none
      "
    >
      {/* Left: model + agents */}
      <div className="flex items-center gap-2">
        <ActiveIndicator active={activeSessions > 0} />
        <ModelBadge name={session?.model || "8gent"} />
        <Separator />
        <AgentCounter active={activeSessions} total={totalSessions} />
      </div>

      {/* Center: status */}
      <div className="flex items-center gap-2">
        <PermissionBadge mode="ask" />
        {session?.status === "processing" && (
          <>
            <Separator />
            <ProcessingStage stage={session.processingStage} />
          </>
        )}
      </div>

      {/* Right: tokens + branch + time */}
      <div className="flex items-center gap-2">
        <TokenCounter tokens={session?.totalTokens || 0} />
        {session?.gitBranch && (
          <>
            <Separator />
            <GitBranch branch={session.gitBranch} />
          </>
        )}
        <Separator />
        <ElapsedTime startTime={session?.createdAt} />
      </div>
    </div>
  );
}

// ── Sub-Components ───────────────────────────────────────────────────

function ActiveIndicator({ active }: { active: boolean }) {
  return (
    <span className={active ? "text-success" : "text-muted"}>
      &#x25B8;&#x25B8;
    </span>
  );
}

function ModelBadge({ name }: { name: string }) {
  return <span className="text-accent font-bold">{name}</span>;
}

function Separator() {
  return <span className="text-muted">&middot;</span>;
}

function AgentCounter({ active, total }: { active: number; total: number }) {
  return (
    <span className={active > 0 ? "text-brand" : "text-muted"}>
      <StatusDot active={active > 0} /> {active}/{total} agents
    </span>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={`
        inline-block w-1.5 h-1.5 rounded-full
        ${active ? "bg-info" : "bg-surface-elevated"}
      `}
    />
  );
}

type PermissionMode = "full" | "ask" | "restricted" | "sandbox" | "infinite";

function PermissionBadge({ mode }: { mode: PermissionMode }) {
  const configs: Record<
    PermissionMode,
    { colorClass: string; icon: string; label: string }
  > = {
    full: { colorClass: "text-danger border-danger", icon: "\u26A0", label: "Full Access" },
    ask: { colorClass: "text-warning border-8-yellow/40", icon: "?", label: "Ask Mode" },
    restricted: { colorClass: "text-success border-success", icon: "\u2713", label: "Restricted" },
    sandbox: { colorClass: "text-info border-info", icon: "\u25A3", label: "Sandbox" },
    infinite: { colorClass: "text-brand border-8-magenta/40", icon: "\u221E", label: "Infinite" },
  };

  const config = configs[mode];

  return (
    <span
      className={`
        px-1.5 py-0.5 rounded border text-xs
        ${config.colorClass}
      `}
    >
      {config.icon} {config.label}
    </span>
  );
}

function ProcessingStage({ stage }: { stage: string }) {
  const labels: Record<string, { text: string; colorClass: string }> = {
    planning: { text: "PLANNING", colorClass: "text-accent" },
    toolshed: { text: "TOOLSHED", colorClass: "text-brand" },
    executing: { text: "EXECUTING", colorClass: "text-warning" },
    complete: { text: "DONE", colorClass: "text-success" },
  };

  const config = labels[stage] || labels.planning;

  return (
    <span className={`font-bold ${config.colorClass}`}>{config.text}</span>
  );
}

function TokenCounter({ tokens }: { tokens: number }) {
  const formatted = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

  return (
    <span className="text-muted">
      <span className="text-success">&darr;</span> {formatted} tokens
    </span>
  );
}

function GitBranch({ branch }: { branch: string }) {
  return (
    <span className="text-warning">
      &#xE0A0; {branch}
    </span>
  );
}

function ElapsedTime({ startTime }: { startTime?: Date }) {
  const [elapsed, setElapsed] = useState("0:00");

  useEffect(() => {
    if (!startTime) return;

    const update = () => {
      const diffMs = Date.now() - startTime.getTime();
      const secs = Math.floor(diffMs / 1000);
      const mins = Math.floor(secs / 60);
      const remSecs = secs % 60;
      setElapsed(`${mins}:${remSecs.toString().padStart(2, "0")}`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span className="text-muted">
      &#x23F1; {elapsed}
    </span>
  );
}
