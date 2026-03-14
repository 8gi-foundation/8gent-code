"use client";

import { useState, useMemo } from "react";
import type { SessionInfo } from "../api/sessions/route";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateStr).getTime()) / 1000
  );
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function projectName(workingDir: string | null): string {
  if (!workingDir) return "unknown";
  const parts = workingDir.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

export default function SessionList({
  sessions,
  activeId,
  onSelect,
}: {
  sessions: SessionInfo[];
  activeId: string | null;
  onSelect: (session: SessionInfo) => void;
}) {
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const projects = useMemo(() => {
    const set = new Set(sessions.map((s) => projectName(s.workingDirectory)));
    return Array.from(set).sort();
  }, [sessions]);

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (projectFilter && projectName(s.workingDirectory) !== projectFilter)
        return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          s.sessionId.toLowerCase().includes(q) ||
          (s.workingDirectory?.toLowerCase().includes(q) ?? false) ||
          (s.firstUserMessage?.toLowerCase().includes(q) ?? false) ||
          (s.model?.toLowerCase().includes(q) ?? false) ||
          (s.gitBranch?.toLowerCase().includes(q) ?? false)
        );
      }
      return true;
    });
  }, [sessions, search, projectFilter]);

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-3 border-b border-zinc-800">
        <input
          type="text"
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/50"
        />
        {/* Project filter */}
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            onClick={() => setProjectFilter(null)}
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              !projectFilter
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            All ({sessions.length})
          </button>
          {projects.map((p) => (
            <button
              key={p}
              onClick={() =>
                setProjectFilter(p === projectFilter ? null : p)
              }
              className={`text-[10px] px-1.5 py-0.5 rounded truncate max-w-[120px] ${
                projectFilter === p
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {filtered.map((session) => (
          <button
            key={session.sessionId}
            onClick={() => onSelect(session)}
            className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors ${
              activeId === session.sessionId
                ? "bg-zinc-800 border-l-2 border-l-emerald-500"
                : ""
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono text-zinc-500">
                  {session.sessionId.replace("session_", "").slice(0, 12)}
                </span>
                {session.completed ? (
                  <span className="text-[9px] text-emerald-500/60">done</span>
                ) : (
                  <span className="text-[9px] text-amber-400/60 animate-pulse">
                    live
                  </span>
                )}
              </div>
              <span className="text-[10px] text-zinc-600">
                {timeAgo(session.modifiedAt)}
              </span>
            </div>
            <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">
              {session.firstUserMessage || (
                <span className="italic text-zinc-600">No user message</span>
              )}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] text-zinc-600 truncate">
                {projectName(session.workingDirectory)}
              </span>
              {session.runtime && (
                <span className="text-[10px] text-cyan-500/50">
                  {session.runtime}
                </span>
              )}
              {session.model && (
                <span className="text-[10px] text-amber-500/60 truncate">
                  {session.model}
                </span>
              )}
              <span className="text-[10px] text-zinc-700 ml-auto">
                {session.durationMs
                  ? formatDuration(session.durationMs)
                  : formatSize(session.sizeBytes)}{" "}
                · {session.lineCount}L
              </span>
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="p-6 text-center text-zinc-600 text-sm">
            No sessions found
          </div>
        )}
      </div>
    </div>
  );
}
