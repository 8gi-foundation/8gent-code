"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type { SessionInfo } from "../api/sessions/route";

interface SessionEntry {
  type: string;
  timestamp?: string;
  sequenceNumber?: number;
  // session_start
  meta?: {
    sessionId?: string;
    version?: number;
    agent?: { model?: string; runtime?: string };
    environment?: { workingDirectory?: string; gitBranch?: string };
  };
  // user_message / assistant_message
  message?: {
    role?: string;
    content?: string;
  };
  // v2: assistant_content
  stepNumber?: number;
  parts?: Array<{
    type: string;
    text?: string;
    signature?: string;
    sourceType?: string;
    id?: string;
    url?: string;
    title?: string;
    mediaType?: string;
    data?: string;
    toolCallId?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }>;
  // tool_call
  toolCall?: {
    toolCallId?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    result?: string;
    success?: boolean;
    durationMs?: number;
  };
  // tool_result
  toolCallId?: string;
  result?: string;
  success?: boolean;
  durationMs?: number;
  toolName?: string;
  // v2: tool_error
  error?: string | { message?: string; recoverable?: boolean };
  // v1: turn_start/turn_end
  turnIndex?: number;
  reason?: string;
  // v2: step_start/step_end
  model?: { provider?: string; modelId?: string };
  finishReason?: string;
  response?: { id?: string; modelId?: string };
  providerMetadata?: Record<string, unknown>;
  // usage
  usage?: {
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    inputTokenDetails?: {
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      noCacheTokens?: number;
    };
    outputTokenDetails?: {
      textTokens?: number;
      reasoningTokens?: number;
    };
  };
  // hook
  hook?: { hookName?: string; hookType?: string; success?: boolean };
  // session_end
  summary?: {
    totalTurns?: number;
    totalSteps?: number;
    totalToolCalls?: number;
    totalTokens?: number;
    totalUsage?: {
      totalTokens?: number;
      promptTokens?: number;
      completionTokens?: number;
    };
    exitReason?: string;
    durationMs?: number;
  };
  containsToolCalls?: boolean;
  messageCount?: number;
  [key: string]: unknown;
}

function EntryBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    session_start: "bg-purple-500/20 text-purple-400",
    user_message: "bg-blue-500/20 text-blue-400",
    assistant_message: "bg-emerald-500/20 text-emerald-400",
    assistant_content: "bg-emerald-500/20 text-emerald-400",
    tool_call: "bg-cyan-500/20 text-cyan-400",
    tool_result: "bg-teal-500/20 text-teal-400",
    tool_error: "bg-red-500/20 text-red-400",
    turn_start: "bg-zinc-700/50 text-zinc-400",
    turn_end: "bg-zinc-700/50 text-zinc-400",
    step_start: "bg-indigo-500/20 text-indigo-400",
    step_end: "bg-indigo-500/20 text-indigo-400",
    hook: "bg-amber-500/20 text-amber-400",
    error: "bg-red-500/20 text-red-400",
    session_end: "bg-purple-500/20 text-purple-400",
  };

  const color = colors[type] || "bg-zinc-700 text-zinc-400";

  return (
    <span
      className={`inline-block text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}
    >
      {type}
    </span>
  );
}

function UsageBadge({ usage }: { usage: SessionEntry["usage"] }) {
  if (!usage?.totalTokens) return null;

  const parts: string[] = [];
  parts.push(`${usage.totalTokens} tok`);
  if (usage.promptTokens) parts.push(`in:${usage.promptTokens}`);
  if (usage.completionTokens) parts.push(`out:${usage.completionTokens}`);
  if (usage.inputTokenDetails?.cacheReadTokens) {
    parts.push(`cache:${usage.inputTokenDetails.cacheReadTokens}`);
  }
  if (usage.outputTokenDetails?.reasoningTokens) {
    parts.push(`think:${usage.outputTokenDetails.reasoningTokens}`);
  }

  return (
    <span className="text-[9px] text-zinc-600 ml-1">
      [{parts.join(" | ")}]
    </span>
  );
}

function ContentParts({ parts }: { parts: NonNullable<SessionEntry["parts"]> }) {
  return (
    <div className="ml-7 mt-1 space-y-1">
      {parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              <div key={i} className="text-xs text-zinc-400">
                {part.text}
              </div>
            );
          case "reasoning":
            return (
              <div key={i} className="text-xs text-amber-400/70 border-l-2 border-amber-500/30 pl-2">
                <span className="text-[9px] text-amber-500/50 mr-1">thinking:</span>
                {part.text}
              </div>
            );
          case "source":
            return (
              <div key={i} className="text-[10px] text-cyan-400/60">
                source: {part.title || part.id} {part.url && `(${part.url})`}
              </div>
            );
          case "file":
            return (
              <div key={i} className="text-[10px] text-purple-400/60">
                file: {part.mediaType} ({part.data ? `${Math.round(part.data.length * 0.75 / 1024)}KB` : "?"})
              </div>
            );
          case "tool-call":
            return (
              <div key={i} className="text-[10px] text-cyan-400/60">
                call: {part.toolName}({JSON.stringify(part.args || {}).slice(0, 60)})
              </div>
            );
          case "tool-result":
            return (
              <div key={i} className="text-[10px] text-teal-400/60">
                result: {part.toolName} = {JSON.stringify(part.result).slice(0, 80)}
              </div>
            );
          case "tool-error":
            return (
              <div key={i} className="text-[10px] text-red-400/60">
                error: {part.toolName} - {part.error}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function EntryContent({ entry }: { entry: SessionEntry }) {
  const [expanded, setExpanded] = useState(false);

  const summary = useMemo(() => {
    switch (entry.type) {
      case "session_start": {
        const version = entry.meta?.version ? `v${entry.meta.version}` : "v1";
        return `${version} ${entry.meta?.agent?.model} via ${entry.meta?.agent?.runtime} — ${entry.meta?.environment?.workingDirectory}`;
      }
      case "user_message":
        return entry.message?.content;
      case "assistant_message": {
        const content = entry.message?.content || "";
        const prefix = entry.containsToolCalls ? "[+tools] " : "";
        return prefix + content;
      }
      case "assistant_content": {
        const textParts = (entry.parts || []).filter(p => p.type === "text");
        const reasoningParts = (entry.parts || []).filter(p => p.type === "reasoning");
        const text = textParts.map(p => p.text).join(" ").slice(0, 200);
        const prefix = reasoningParts.length ? `[thinking] ` : "";
        return `Step ${entry.stepNumber}: ${prefix}${text || "(tool calls only)"}`;
      }
      case "tool_call":
        return `${entry.toolCall?.name}(${JSON.stringify(entry.toolCall?.arguments || {}).slice(0, 80)})`;
      case "tool_result":
        return `${entry.success ? "✓" : "✗"} ${entry.toolName || entry.toolCallId} ${entry.durationMs ? `(${entry.durationMs}ms)` : ""}`;
      case "tool_error":
        return `✗ ${entry.toolName} — ${typeof entry.error === "string" ? entry.error : (entry.error as any)?.message}`;
      case "turn_start":
        return `Turn ${entry.turnIndex}`;
      case "turn_end":
        return `Turn ${entry.turnIndex} → ${entry.reason}${entry.usage?.totalTokens ? ` (${entry.usage.totalTokens} tokens)` : ""}`;
      case "step_start": {
        const modelStr = entry.model?.modelId ? ` [${entry.model.modelId}]` : "";
        return `Step ${entry.stepNumber}${modelStr}${entry.messageCount ? ` (${entry.messageCount} msgs)` : ""}`;
      }
      case "step_end":
        return `Step ${entry.stepNumber} → ${entry.finishReason}`;
      case "hook":
        return `${entry.hook?.hookType}: ${entry.hook?.hookName} ${entry.hook?.success ? "✓" : "✗"}`;
      case "error": {
        const errMsg = typeof entry.error === "string" ? entry.error : (entry.error as any)?.message;
        const recoverable = typeof entry.error === "object" && (entry.error as any)?.recoverable;
        return `${recoverable ? "[recoverable]" : "[fatal]"} ${errMsg}`;
      }
      case "session_end": {
        const steps = entry.summary?.totalSteps ?? entry.summary?.totalTurns;
        const tokens = entry.summary?.totalUsage?.totalTokens ?? entry.summary?.totalTokens;
        return `${entry.summary?.exitReason} — ${steps} steps, ${entry.summary?.totalToolCalls} tools, ${tokens} tokens`;
      }
      default:
        return null;
    }
  }, [entry]);

  const timestamp = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString()
    : null;

  return (
    <div
      className={`border-b border-zinc-800/50 px-4 py-2 hover:bg-zinc-900/50 transition-colors ${
        expanded ? "bg-zinc-900/30" : ""
      }`}
    >
      <div
        className="flex items-start gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-[10px] text-zinc-600 mt-0.5 shrink-0 w-5">
          {expanded ? "▼" : "▶"}
        </span>
        <span className="text-[9px] text-zinc-700 mt-0.5 shrink-0 w-6 text-right">
          {entry.sequenceNumber ?? ""}
        </span>
        <EntryBadge type={entry.type} />
        {timestamp && (
          <span className="text-[10px] text-zinc-600 shrink-0 mt-0.5">
            {timestamp}
          </span>
        )}
        {summary && (
          <span className="text-xs text-zinc-400 truncate">{summary}</span>
        )}
        {(entry.type === "step_end" || entry.type === "assistant_content") && (
          <UsageBadge usage={entry.usage} />
        )}
      </div>

      {/* v2: Render content parts inline for assistant_content */}
      {entry.type === "assistant_content" && entry.parts && !expanded && (
        <ContentParts parts={entry.parts} />
      )}

      {expanded && (
        <pre className="mt-2 ml-7 text-[11px] text-zinc-500 overflow-x-auto max-h-[600px] overflow-y-auto bg-black/30 rounded p-3 border border-zinc-800">
          {JSON.stringify(entry, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function SessionViewer({
  session,
}: {
  session: SessionInfo;
}) {
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [isLive, setIsLive] = useState(true);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [copiedJson, setCopiedJson] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries([]);
    setInitialLoaded(false);

    const url = `/api/sessions/${session.sessionId}/stream`;
    const es = new EventSource(url);

    const batch: SessionEntry[] = [];
    let batchTimeout: ReturnType<typeof setTimeout> | null = null;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "__initial_load_complete__") {
          setInitialLoaded(true);
          return;
        }
        if (data.type === "__error__") {
          return;
        }

        batch.push(data);

        if (!batchTimeout) {
          batchTimeout = setTimeout(() => {
            const flushing = batch.splice(0);
            setEntries((prev) => [...prev, ...flushing]);
            batchTimeout = null;
          }, 50);
        }
      } catch {
        // skip
      }
    };

    es.onerror = () => {};

    return () => {
      es.close();
      if (batchTimeout) clearTimeout(batchTimeout);
    };
  }, [session.sessionId]);

  // Auto-scroll when live
  useEffect(() => {
    if (isLive && initialLoaded && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [entries.length, isLive, initialLoaded]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entries) {
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    return counts;
  }, [entries]);

  const filtered = useMemo(() => {
    if (!typeFilter) return entries;
    return entries.filter((e) => e.type === typeFilter);
  }, [entries, typeFilter]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 100;
    setIsLive(atBottom);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/50">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-mono text-zinc-300">
              {session.sessionId.replace("session_", "").slice(0, 16)}
            </h2>
            {session.workingDirectory && (
              <span className="text-xs text-zinc-600">
                {session.workingDirectory.split("/").slice(-2).join("/")}
              </span>
            )}
            {session.gitBranch && (
              <span className="text-[10px] text-cyan-500/60 font-mono">
                {session.gitBranch}
              </span>
            )}
            {session.runtime && (
              <span className="text-[10px] text-amber-500/50">
                {session.runtime}:{session.model}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const url = `${window.location.origin}?session=${session.sessionId}`;
                navigator.clipboard.writeText(url);
                setCopiedUrl(true);
                setTimeout(() => setCopiedUrl(false), 2000);
              }}
              className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              {copiedUrl ? "✓ Copied URL" : "Copy URL"}
            </button>
            <button
              onClick={() => {
                const json = JSON.stringify(entries, null, 2);
                navigator.clipboard.writeText(json);
                setCopiedJson(true);
                setTimeout(() => setCopiedJson(false), 2000);
              }}
              className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              {copiedJson ? "✓ Copied JSON" : "Copy as JSON"}
            </button>
            {!initialLoaded && (
              <span className="text-[10px] text-amber-400 animate-pulse">
                Loading...
              </span>
            )}
            {initialLoaded && (
              <span
                className={`text-[10px] ${
                  !session.completed
                    ? "text-emerald-400"
                    : "text-zinc-600"
                }`}
              >
                {!session.completed ? "● LIVE" : `○ ${session.exitReason}`}
              </span>
            )}
            <span className="text-[10px] text-zinc-600">
              {entries.length} entries
            </span>
          </div>
        </div>

        {/* Type filters */}
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setTypeFilter(null)}
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              !typeFilter
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            All
          </button>
          {Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <button
                key={type}
                onClick={() =>
                  setTypeFilter(type === typeFilter ? null : type)
                }
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  typeFilter === type
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {type.replace("_", " ")} ({count})
              </button>
            ))}
        </div>
      </div>

      {/* Entries */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        {filtered.map((entry, i) => (
          <EntryContent
            key={`${entry.sequenceNumber ?? i}-${i}`}
            entry={entry}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
