/**
 * 8gent CLUI — Main Application Shell
 * Fully wired: Tauri IPC → Rust AgentManager → Bun subprocess → NDJSON events
 */

import React, { useState, useEffect, useRef } from "react";

// ── Tauri API (lazy-loaded, falls back gracefully in browser) ───
let invoke: ((cmd: string, args?: any) => Promise<any>) | null = null;
let listen: ((event: string, handler: (e: any) => void) => Promise<() => void>) | null = null;
let tauriWindow: any = null;

async function loadTauri() {
  try {
    const core = await import("@tauri-apps/api/core");
    invoke = core.invoke;
    const events = await import("@tauri-apps/api/event");
    listen = events.listen;

    // Test if invoke actually works by calling list_sessions
    await invoke("list_sessions");
    console.log("[CLUI] Tauri IPC confirmed working");

    try {
      const win = await import("@tauri-apps/api/window");
      tauriWindow = win.getCurrentWindow();
    } catch {}

    return true;
  } catch (err) {
    console.log("[CLUI] Tauri IPC not available:", err);
    return false;
  }
}

// ── Theme System ────────────────────────────────────────────────
const themes = {
  dark: {
    bg: "#0c0e14", bgSecondary: "#141620", bgElevated: "#1a1d2e",
    text: "#e2e4ef", textSecondary: "#8b8fa3", textMuted: "#5c6078",
    border: "#2a2d3e",
    cyan: "#06b6d4", magenta: "#a855f7", yellow: "#eab308",
    green: "#22c55e", red: "#ef4444", blue: "#3b82f6",
    userBubble: "#1a1d2e",
  },
  light: {
    bg: "#f8f9fc", bgSecondary: "#eef0f5", bgElevated: "#ffffff",
    text: "#1a1d2e", textSecondary: "#5c6078", textMuted: "#8b8fa3",
    border: "#d1d5e0",
    cyan: "#0891b2", magenta: "#9333ea", yellow: "#ca8a04",
    green: "#16a34a", red: "#dc2626", blue: "#2563eb",
    userBubble: "#eef0f5",
  },
} as const;

type Theme = typeof themes.dark;
type ThemeMode = "dark" | "light" | "system";

function getSystemTheme(): "dark" | "light" {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function resolveTheme(mode: ThemeMode): Theme {
  return mode === "system" ? themes[getSystemTheme()] : themes[mode];
}

// ── Window Controls ─────────────────────────────────────────────
function WindowControls({ t }: { t: Theme }) {
  return (
    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
      <button onClick={() => tauriWindow?.minimize()} title="Minimize"
        style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: t.yellow, border: "none", cursor: "pointer", padding: 0, fontSize: 0 }} />
      <button onClick={() => tauriWindow?.toggleMaximize()} title="Maximize"
        style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: t.green, border: "none", cursor: "pointer", padding: 0, fontSize: 0 }} />
      <button onClick={() => tauriWindow?.close()} title="Close"
        style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: t.red, border: "none", cursor: "pointer", padding: 0, fontSize: 0 }} />
    </div>
  );
}

// ── Message Types ───────────────────────────────────────────────
interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
}

// ── App ─────────────────────────────────────────────────────────
export function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem("8gent-theme") as ThemeMode) || "dark"; } catch { return "dark"; }
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTauri, setIsTauri] = useState(false);
  const [currentModel, setCurrentModel] = useState("eight:latest");
  const [streamingText, setStreamingText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const t = resolveTheme(themeMode);
  const isDark = t === themes.dark;

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Persist theme
  useEffect(() => {
    try { localStorage.setItem("8gent-theme", themeMode); } catch {}
    document.body.style.backgroundColor = t.bg;
  }, [themeMode, t.bg]);

  // Theme keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === "T") {
        e.preventDefault();
        setThemeMode((p) => (["dark", "light", "system"] as ThemeMode[])[(["dark", "light", "system"].indexOf(p) + 1) % 3]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Initialize Tauri + create session
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    async function init() {
      const hasTauri = await loadTauri();
      setIsTauri(hasTauri);

      if (hasTauri && invoke && listen) {
        // Listen for agent events
        unlisten = await listen("agent_event", (event: any) => {
          const payload = event.payload as { session_id: string; event: { type: string; [key: string]: any } };
          const evt = payload.event;

          switch (evt.type) {
            case "session_start":
              addMsg("system", `Connected to agent (model: ${evt.model || currentModel})`);
              setIsConnected(true);
              break;

            case "session_end":
              addMsg("system", `Session ended: ${evt.reason || "process exited"}`);
              setIsConnected(false);
              setIsProcessing(false);
              break;

            case "text":
              // Plain text output from the agent
              if (evt.content || evt.data?.content) {
                const text = evt.content || evt.data?.content;
                setStreamingText((prev) => prev + text + "\n");
              }
              break;

            case "message":
            case "assistant_message":
              // Complete assistant message
              flushStreaming();
              if (evt.content || evt.data?.content) {
                addMsg("assistant", evt.content || evt.data?.content);
              }
              setIsProcessing(false);
              break;

            case "tool_start":
            case "tool_call":
              addMsg("tool", `→ ${evt.tool_name || evt.data?.toolName || "tool"}(${JSON.stringify(evt.input || evt.data?.args || {}).slice(0, 80)})`);
              break;

            case "tool_end":
            case "tool_result":
              // Tool completed
              break;

            case "thinking":
              setStreamingText((prev) => prev + (evt.content || evt.data?.content || "") );
              break;

            case "error":
              addMsg("system", `Error: ${evt.message || evt.data?.message || "Unknown error"}`);
              setIsProcessing(false);
              break;

            case "stderr":
              // Log stderr but don't show to user unless it's an error
              console.warn(`[agent stderr] ${evt.content || evt.data?.content}`);
              break;

            default:
              // Unknown event — forward as text if it has content
              if (evt.content || evt.data?.content) {
                setStreamingText((prev) => prev + (evt.content || evt.data?.content));
              }
              break;
          }
        }) as unknown as () => void;

        // Create initial session
        try {
          const sid = await invoke("create_session", {
            model: currentModel,
            cwd: null, // Uses repo root
          });
          setSessionId(sid);
          addMsg("system", "∞ 8gent CLUI — The Infinite Gentleman");
          addMsg("system", "Session created. Ask anything or use /theme to switch modes.");
        } catch (err: any) {
          addMsg("system", `Failed to create session: ${err}`);
        }
      } else {
        // Browser preview mode — mock
        addMsg("system", "∞ 8gent CLUI — The Infinite Gentleman");
        addMsg("system", "Running in browser preview mode (no Tauri). Launch via `npx @tauri-apps/cli dev` for full agent.");
        addMsg("system", "Tip: Cmd+Shift+T to toggle theme · /theme light|dark|system");
      }
    }

    init();

    return () => { unlisten?.(); };
  }, []);

  function addMsg(role: Message["role"], content: string) {
    setMessages((prev) => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role,
      content,
      timestamp: Date.now(),
    }]);
  }

  function flushStreaming() {
    setStreamingText((prev) => {
      if (prev.trim()) {
        addMsg("assistant", prev.trim());
      }
      return "";
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");

    // Handle /debug command
    if (text === "/debug") {
      const hasTauri = !!(window as any).__TAURI_INTERNALS__;
      const hasTauri2 = !!(window as any).__TAURI__;
      addMsg("system", [
        `__TAURI_INTERNALS__: ${hasTauri}`,
        `__TAURI__: ${hasTauri2}`,
        `invoke loaded: ${!!invoke}`,
        `listen loaded: ${!!listen}`,
        `isTauri state: ${isTauri}`,
        `sessionId: ${sessionId}`,
        `isConnected: ${isConnected}`,
        `window.location: ${window.location.href}`,
        `userAgent: ${navigator.userAgent.slice(0, 80)}`,
      ].join("\n"));
      setInput("");
      return;
    }

    // Handle /theme command locally
    if (text.startsWith("/theme")) {
      const arg = text.split(" ")[1]?.toLowerCase();
      if (arg === "light" || arg === "dark" || arg === "system") {
        setThemeMode(arg);
        addMsg("system", `Theme set to: ${arg}`);
      } else {
        addMsg("system", "Usage: /theme dark|light|system");
      }
      return;
    }

    // Add user message
    addMsg("user", text);

    if (isTauri && invoke && sessionId) {
      // Send to real agent via Tauri IPC
      setIsProcessing(true);
      setStreamingText("");
      try {
        await invoke("send_to_agent", { sessionId, content: text });
      } catch (err: any) {
        addMsg("system", `Failed to send: ${err}`);
        setIsProcessing(false);
      }
    } else {
      // Browser preview mock
      setTimeout(() => {
        addMsg("assistant", `[Preview mode] Received: "${text}". Launch in Tauri for real agent.`);
      }, 300);
    }

    inputRef.current?.focus();
  }

  const themeLabel = themeMode === "system" ? `${getSystemTheme()}` : themeMode;

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh",
      backgroundColor: t.bg, color: t.text,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace", fontSize: "13px",
      transition: "background-color 200ms, color 200ms",
    }}>
      {/* Title Bar */}
      <div data-tauri-drag-region style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 16px", backgroundColor: t.bgSecondary,
        borderBottom: `1px solid ${t.border}`, userSelect: "none",
        transition: "background-color 200ms",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: t.cyan, fontWeight: "bold" }}>∞</span>
          <span style={{ color: t.cyan }}>8gent CLUI</span>
          <span style={{ color: t.textMuted, fontSize: "11px" }}>v0.6.0</span>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button onClick={() => setThemeMode((p) => (["dark", "light", "system"] as ThemeMode[])[(["dark", "light", "system"].indexOf(p) + 1) % 3])}
            title={`Theme: ${themeLabel} (Cmd+Shift+T)`}
            style={{
              padding: "2px 8px", borderRadius: "4px", fontSize: "10px",
              backgroundColor: t.bgElevated, color: t.yellow,
              border: `1px solid ${t.border}`, cursor: "pointer", fontFamily: "inherit",
            }}>
            {isDark ? "◐" : "◑"} {themeLabel}
          </button>
          <span style={{
            padding: "2px 8px", borderRadius: "4px", fontSize: "10px",
            backgroundColor: t.bgElevated, border: `1px solid ${t.border}`,
            color: isConnected ? t.green : t.textMuted,
          }}>
            {isConnected ? "● Connected" : "○ Guest"}
          </span>
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: "2px",
        padding: "4px 8px", backgroundColor: t.bgSecondary,
        borderBottom: `1px solid ${t.border}`,
      }}>
        <div style={{
          padding: "4px 12px", borderRadius: "4px 4px 0 0",
          backgroundColor: t.bg, color: t.text, fontSize: "11px",
          border: `1px solid ${t.border}`, borderBottom: "none",
        }}>
          {sessionId || "Session 1"}
        </div>
        <button style={{
          padding: "4px 8px", background: "none", border: "none",
          color: t.textMuted, cursor: "pointer", fontSize: "14px", fontFamily: "inherit",
        }}>+</button>
      </div>

      {/* Message Area */}
      <div style={{
        flex: 1, overflow: "auto", padding: "16px",
        display: "flex", flexDirection: "column", gap: "8px",
      }}>
        {messages.map((msg) => (
          <div key={msg.id} style={{
            padding: "8px 12px", borderRadius: "6px",
            backgroundColor: msg.role === "user" ? t.userBubble : "transparent",
            borderLeft: msg.role === "system" ? `2px solid ${t.cyan}`
              : msg.role === "assistant" ? `2px solid ${t.magenta}`
              : msg.role === "tool" ? `2px solid ${t.blue}`
              : "none",
            transition: "background-color 200ms",
          }}>
            <span style={{
              color: msg.role === "user" ? t.yellow
                : msg.role === "assistant" ? t.magenta
                : msg.role === "tool" ? t.blue
                : t.cyan,
              fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px",
            }}>
              {msg.role === "user" ? "You" : msg.role === "assistant" ? "8gent" : msg.role === "tool" ? "Tool" : "System"}
            </span>
            <div style={{ marginTop: "4px", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>
              {msg.content}
            </div>
          </div>
        ))}

        {/* Streaming text (in-progress) */}
        {streamingText && (
          <div style={{
            padding: "8px 12px", borderRadius: "6px",
            borderLeft: `2px solid ${t.magenta}`,
            opacity: 0.8,
          }}>
            <span style={{ color: t.magenta, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              8gent <span style={{ animation: "pulse 1s infinite" }}>●</span>
            </span>
            <div style={{ marginTop: "4px", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>
              {streamingText}
            </div>
          </div>
        )}

        {/* Processing indicator */}
        {isProcessing && !streamingText && (
          <div style={{ padding: "8px 12px", color: t.textMuted }}>
            <span style={{ color: t.cyan }}>⋯</span> Agent is thinking...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <form onSubmit={handleSubmit} style={{
        display: "flex", gap: "8px", padding: "12px 16px",
        borderTop: `1px solid ${t.border}`, backgroundColor: t.bgSecondary,
        transition: "background-color 200ms",
      }}>
        <span style={{ color: t.cyan, paddingTop: "2px" }}>❯</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isProcessing ? "Agent is working..." : "Ask 8gent anything..."}
          disabled={isProcessing}
          autoFocus
          style={{
            flex: 1, background: "none", border: "none", outline: "none",
            color: t.text, fontFamily: "inherit", fontSize: "13px",
            opacity: isProcessing ? 0.5 : 1,
            transition: "color 200ms",
          }}
        />
        {isProcessing && (
          <button
            type="button"
            onClick={() => { setIsProcessing(false); flushStreaming(); }}
            style={{
              padding: "2px 8px", borderRadius: "4px", fontSize: "10px",
              backgroundColor: t.red, color: "#fff", border: "none",
              cursor: "pointer", fontFamily: "inherit",
            }}
          >
            Stop
          </button>
        )}
      </form>

      {/* Status Bar */}
      <div style={{
        display: "flex", justifyContent: "space-between",
        padding: "4px 16px", backgroundColor: t.bg,
        borderTop: `1px solid ${t.border}`, fontSize: "10px", color: t.textMuted,
        transition: "background-color 200ms",
      }}>
        <div style={{ display: "flex", gap: "12px" }}>
          <span><span style={{ color: t.green }}>▸▸</span> {currentModel}</span>
          <span>· {isConnected ? "1" : "0"}/1 agents</span>
          <span>·{" "}
            <span style={{
              padding: "1px 6px", border: `1px solid ${t.yellow}`,
              borderRadius: "3px", color: t.yellow,
            }}>❓ Ask Mode</span>
          </span>
          {!isTauri && <span style={{ color: t.red }}>· Browser Preview</span>}
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <span><span style={{ color: t.yellow }}></span> main</span>
          <span>⏱ 0:00</span>
        </div>
      </div>
    </div>
  );
}
