"use client";

import { useEffect, useState, useCallback } from "react";
import SessionList from "./components/SessionList";
import SessionViewer from "./components/SessionViewer";
import SystemHealth from "./components/SystemHealth";
import type { SessionInfo } from "./api/sessions/route";

export default function Home() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState<"sessions" | "health">("sessions");
  const [isDark, setIsDark] = useState(true);

  // Init theme from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("8gent-debugger-theme");
    if (saved === "light") {
      setIsDark(false);
      document.documentElement.classList.remove("dark");
    } else if (saved === "dark" || document.documentElement.classList.contains("dark")) {
      setIsDark(true);
    } else {
      // System preference
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      setIsDark(dark);
    }
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("8gent-debugger-theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("8gent-debugger-theme", "light");
    }
  };

  // Read session ID from URL on mount
  const getSessionIdFromURL = useCallback(() => {
    if (typeof window === "undefined") return null;
    const url = new URL(window.location.href);
    return url.searchParams.get("session");
  }, []);

  // Sync session selection to URL
  const selectSession = useCallback(
    (s: SessionInfo | null) => {
      setActive(s);
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (s) {
        url.searchParams.set("session", s.sessionId);
      } else {
        url.searchParams.delete("session");
      }
      window.history.replaceState({}, "", url.toString());
    },
    []
  );

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => {
        setSessions(data);
        setLoading(false);

        // Auto-select session from URL
        const urlSessionId = getSessionIdFromURL();
        if (urlSessionId) {
          const match = data.find(
            (s: SessionInfo) => s.sessionId === urlSessionId
          );
          if (match) setActive(match);
        }
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [getSessionIdFromURL]);

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
    <div className="flex h-screen" style={{ background: "var(--background)", color: "var(--foreground)" }}>
      {/* Sidebar */}
      <div
        className="flex-shrink-0 flex flex-col"
        style={{ width: sidebarWidth, borderRight: "1px solid var(--border)", background: "var(--background)" }}
      >
        {/* Logo + View Toggle + Theme */}
        <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 font-mono font-bold text-lg">
              8gent
            </span>
            <span style={{ color: "var(--muted)" }} className="text-xs">debugger</span>
            <button
              onClick={toggleTheme}
              className="ml-auto text-xs px-2 py-0.5 rounded"
              style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
            >
              {isDark ? "☀ Light" : "🌙 Dark"}
            </button>
          </div>
          <div className="flex items-center gap-1 mt-2">
            <button
              onClick={() => setView("sessions")}
              className={`text-[10px] px-2 py-1 rounded ${
                view === "sessions"
                  ? "bg-emerald-500/20 text-emerald-400"
                  : ""
              }`}
              style={view !== "sessions" ? { color: "var(--muted)" } : undefined}
            >
              Sessions {!loading && `(${sessions.length})`}
            </button>
            <button
              onClick={() => setView("health")}
              className={`text-[10px] px-2 py-1 rounded ${
                view === "health"
                  ? "bg-cyan-500/20 text-cyan-400"
                  : ""
              }`}
              style={view !== "health" ? { color: "var(--muted)" } : undefined}
            >
              System Health
            </button>
          </div>
        </div>

        {error ? (
          <div className="p-4 text-red-400 text-xs">{error}</div>
        ) : (
          <SessionList
            sessions={sessions}
            activeId={active?.sessionId ?? null}
            onSelect={(s) => selectSession(s)}
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
        {view === "health" ? (
          <SystemHealth />
        ) : active ? (
          <SessionViewer session={active} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center" style={{ color: "var(--muted)" }}>
              <p className="text-4xl mb-4 font-mono">8</p>
              <p className="text-sm">Select a session to inspect</p>
              <p className="text-xs mt-2" style={{ color: "var(--border)" }}>
                Sessions stream live from ~/.8gent/sessions
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
