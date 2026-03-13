"use client";

import { useEffect, useState } from "react";
import SessionList from "./components/SessionList";
import SessionViewer from "./components/SessionViewer";
import type { SessionInfo } from "./api/sessions/route";

export default function Home() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    console.log("[Debugger:Page] Fetching sessions list...");
    fetch("/api/sessions")
      .then((r) => {
        console.log(`[Debugger:Page] Sessions API responded: ${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data) => {
        console.log(`[Debugger:Page] Got ${data.length} sessions:`, data.map((s: SessionInfo) => s.sessionId));
        setSessions(data);
        setLoading(false);
      })
      .catch((e) => {
        console.error("[Debugger:Page] Failed to fetch sessions:", e);
        setError(String(e));
        setLoading(false);
      });
  }, []);

  // Refresh session list every 10s
  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/sessions")
        .then((r) => r.json())
        .then(setSessions)
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // Resizable sidebar
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      setSidebarWidth(Math.max(240, Math.min(600, e.clientX)));
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-200">
      {/* Sidebar */}
      <div
        className="flex-shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col"
        style={{ width: sidebarWidth }}
      >
        {/* Logo */}
        <div className="px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 font-mono font-bold text-lg">
              8gent
            </span>
            <span className="text-zinc-600 text-xs">debugger</span>
          </div>
          <p className="text-[10px] text-zinc-600 mt-0.5">
            {loading ? "Loading..." : `${sessions.length} sessions`}
          </p>
        </div>

        {error ? (
          <div className="p-4 text-red-400 text-xs">{error}</div>
        ) : (
          <SessionList
            sessions={sessions}
            activeId={active?.sessionId ?? null}
            onSelect={(s) => {
              console.log(`[Debugger:Page] Selected session: ${s.sessionId}, lines=${s.lineCount}, completed=${s.completed}`);
              setActive(s);
            }}
          />
        )}
      </div>

      {/* Resize handle */}
      <div
        className={`w-1 cursor-col-resize hover:bg-emerald-500/30 transition-colors ${
          dragging ? "bg-emerald-500/30" : ""
        }`}
        onMouseDown={() => setDragging(true)}
      />

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {active ? (
          <SessionViewer session={active} />
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-700">
            <div className="text-center">
              <p className="text-4xl mb-4 font-mono">8</p>
              <p className="text-sm">Select a session to inspect</p>
              <p className="text-xs text-zinc-800 mt-2">
                Sessions stream live from ~/.8gent/sessions
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
