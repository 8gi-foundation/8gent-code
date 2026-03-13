"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import type { SessionInfo } from "../api/sessions/route";

interface SessionEntry {
  type: string;
  timestamp?: string;
  sequenceNumber?: number;
  message?: {
    role?: string;
    content?: string;
  };
  meta?: {
    sessionId?: string;
    agent?: { model?: string; runtime?: string };
    environment?: { workingDirectory?: string; gitBranch?: string };
  };
  toolCall?: {
    toolCallId?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    result?: string;
    success?: boolean;
    durationMs?: number;
  };
  toolCallId?: string;
  result?: string;
  success?: boolean;
  durationMs?: number;
  turnIndex?: number;
  usage?: { totalTokens?: number };
  hook?: { hookName?: string; hookType?: string; success?: boolean };
  error?: { message?: string; recoverable?: boolean };
  summary?: {
    totalTurns?: number;
    totalToolCalls?: number;
    totalTokens?: number;
    exitReason?: string;
    durationMs?: number;
  };
  reason?: string;
  containsToolCalls?: boolean;
  [key: string]: unknown;
}

function EntryBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    session_start: "bg-purple-500/20 text-purple-400",
    user_message: "bg-blue-500/20 text-blue-400",
    assistant_message: "bg-emerald-500/20 text-emerald-400",
    tool_call: "bg-cyan-500/20 text-cyan-400",
    tool_result: "bg-teal-500/20 text-teal-400",
    turn_start: "bg-zinc-700/50 text-zinc-400",
    turn_end: "bg-zinc-700/50 text-zinc-400",
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

function EntryContent({ entry }: { entry: SessionEntry }) {
  const [expanded, setExpanded] = useState(false);

  const summary = useMemo(() => {
    switch (entry.type) {
      case "session_start":
        return `${entry.meta?.agent?.model} via ${entry.meta?.agent?.runtime} — ${entry.meta?.environment?.workingDirectory}`;
      case "user_message":
        return entry.message?.content;
      case "assistant_message": {
        const content = entry.message?.content || "";
        const prefix = entry.containsToolCalls ? "[+tools] " : "";
        return prefix + content;
      }
      case "tool_call":
        return `${entry.toolCall?.name}(${JSON.stringify(entry.toolCall?.arguments || {}).slice(0, 80)})`;
      case "tool_result":
        return `${entry.success ? "✓" : "✗"} ${entry.toolCallId} ${entry.durationMs ? `(${entry.durationMs}ms)` : ""}`;
      case "turn_start":
        return `Turn ${entry.turnIndex}`;
      case "turn_end":
        return `Turn ${entry.turnIndex} → ${entry.reason}${entry.usage?.totalTokens ? ` (${entry.usage.totalTokens} tokens)` : ""}`;
      case "hook":
        return `${entry.hook?.hookType}: ${entry.hook?.hookName} ${entry.hook?.success ? "✓" : "✗"}`;
      case "error":
        return `${entry.error?.recoverable ? "[recoverable]" : "[fatal]"} ${entry.error?.message}`;
      case "session_end":
        return `${entry.summary?.exitReason} — ${entry.summary?.totalTurns} turns, ${entry.summary?.totalToolCalls} tools, ${entry.summary?.totalTokens} tokens`;
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
      </div>

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
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEntries([]);
    setInitialLoaded(false);

    const url = `/api/sessions/${session.sessionId}/stream`;
    console.log(`[Debugger] Opening EventSource: ${url}`);

    const es = new EventSource(url);

    const batch: SessionEntry[] = [];
    let batchTimeout: ReturnType<typeof setTimeout> | null = null;
    let messageCount = 0;

    es.onopen = () => {
      console.log(`[Debugger] EventSource OPEN for ${session.sessionId}`);
    };

    es.onmessage = (event) => {
      messageCount++;
      console.log(`[Debugger] SSE message #${messageCount}, length=${event.data.length}, preview=${event.data.slice(0, 100)}`);
      try {
        const data = JSON.parse(event.data);
        console.log(`[Debugger] Parsed entry type="${data.type}" seq=${data.sequenceNumber}`);

        if (data.type === "__initial_load_complete__") {
          console.log(`[Debugger] Initial load complete, ${data.lineCount} lines from server`);
          setInitialLoaded(true);
          return;
        }
        if (data.type === "__error__") {
          console.error("[Debugger] Stream error:", data.message);
          return;
        }

        batch.push(data);
        console.log(`[Debugger] Batch size: ${batch.length}`);

        if (!batchTimeout) {
          batchTimeout = setTimeout(() => {
            const flushing = batch.splice(0);
            console.log(`[Debugger] Flushing ${flushing.length} entries to state`);
            setEntries((prev) => {
              const next = [...prev, ...flushing];
              console.log(`[Debugger] State updated: ${prev.length} -> ${next.length} entries`);
              return next;
            });
            batchTimeout = null;
          }, 50);
        }
      } catch (err) {
        console.error(`[Debugger] Failed to parse SSE message #${messageCount}:`, err, event.data.slice(0, 200));
      }
    };

    es.onerror = (err) => {
      console.error(`[Debugger] EventSource ERROR for ${session.sessionId}, readyState=${es.readyState}`, err);
    };

    console.log(`[Debugger] EventSource created, readyState=${es.readyState} (0=CONNECTING, 1=OPEN, 2=CLOSED)`);

    return () => {
      console.log(`[Debugger] Closing EventSource for ${session.sessionId}, received ${messageCount} messages total`);
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
