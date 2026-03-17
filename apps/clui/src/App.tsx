/**
 * 8gent CLUI — Main Application Shell
 * Fully wired: Tauri IPC -> Rust AgentManager -> Bun subprocess -> NDJSON events
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ── Tauri Detection ─────────────────────────────────────────────
const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;
const tauriWindow = IS_TAURI ? getCurrentWindow() : null;

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

type Theme = { [K in keyof typeof themes.dark]: string };
type ThemeMode = "dark" | "light" | "system";

function getSystemTheme(): "dark" | "light" {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function resolveTheme(mode: ThemeMode): Theme {
  const key = mode === "system" ? getSystemTheme() : mode;
  return themes[key] as Theme;
}

// ── Message Types ───────────────────────────────────────────────
interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "error";
  content: string;
  timestamp: number;
}

interface TabState {
  id: string;
  sessionId: string | null;
  label: string;
  messages: Message[];
  isConnected: boolean;
  isProcessing: boolean;
  streamingText: string;
  model: string;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function createTab(model: string): TabState {
  return {
    id: makeId(),
    sessionId: null,
    label: "New Session",
    messages: [],
    isConnected: false,
    isProcessing: false,
    streamingText: "",
    model,
  };
}

function makeMsg(role: Message["role"], content: string): Message {
  return { id: makeId(), role, content, timestamp: Date.now() };
}

// ── App ─────────────────────────────────────────────────────────
export function App() {
  const [input, setInput] = useState("");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try { return (localStorage.getItem("8gent-theme") as ThemeMode) || "dark"; } catch { return "dark"; }
  });
  const defaultModel = "eight:latest";
  const [tabs, setTabs] = useState<TabState[]>(() => [createTab(defaultModel)]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]?.id ?? "");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Track whether initial connection has been attempted
  const initDone = useRef(false);

  const t = resolveTheme(themeMode);
  const isDark = t === themes.dark;

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  // ── Tab state helpers (stable refs via functional setState) ────
  const updateTab = useCallback((tabId: string, updater: (tab: TabState) => Partial<TabState>) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, ...updater(tab) } : tab))
    );
  }, []);

  const addMsgToTab = useCallback((tabId: string, role: Message["role"], content: string) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, messages: [...tab.messages, makeMsg(role, content)] } : tab
      )
    );
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeTab?.messages, activeTab?.streamingText]);

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

  // ── Create session for a tab ──────────────────────────────────
  const connectTab = useCallback(async (tabId: string, model?: string) => {
    // Read current tab state
    let useModel = model ?? defaultModel;
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      if (tab && !model) useModel = tab.model;
      return prev;
    });

    addMsgToTab(tabId, "system", `Creating agent session (model: ${useModel})...`);

    try {
      const sid = await invoke("create_session", {
        model: useModel,
        cwd: null,
      });
      const sidStr = sid as string;
      updateTab(tabId, () => ({
        sessionId: sidStr,
        label: useModel,
        model: useModel,
        isConnected: false, // will be set true when session_start event arrives
      }));
      addMsgToTab(tabId, "system", `Session ${sidStr} created. Waiting for agent...`);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || JSON.stringify(err);
      addMsgToTab(tabId, "error", `Session creation failed: ${errMsg}`);
      addMsgToTab(tabId, "system", "Type /connect to retry, or /debug for diagnostics.");
    }
  }, [addMsgToTab, updateTab, defaultModel]);

  // ── Initialize Tauri + event listener (runs once) ─────────────
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    let unlisten: (() => void) | null = null;
    const initialTabId = tabs[0]?.id;

    async function init() {
      if (!IS_TAURI) {
        addMsgToTab(initialTabId, "system", "8gent CLUI -- The Infinite Gentleman\nRunning in browser preview mode (no Tauri).\nLaunch via `cargo tauri dev` for full agent.\nTip: Cmd+Shift+T to toggle theme");
        return;
      }

      // Listen for agent events from ALL sessions
      unlisten = await listen("agent_event", (event: any) => {
        const payload = event.payload as {
          session_id: string;
          event: { type: string; [key: string]: any };
        };
        const sid = payload.session_id;
        const evt = payload.event;

        setTabs((prevTabs) => {
          const tabIdx = prevTabs.findIndex((t) => t.sessionId === sid);
          if (tabIdx === -1) {
            console.warn(`[agent_event] No tab for session ${sid}, event: ${evt.type}`);
            return prevTabs;
          }
          const tab = prevTabs[tabIdx];
          const updated = { ...tab };

          switch (evt.type) {
            case "session_start":
              updated.isConnected = true;
              updated.messages = [...tab.messages, makeMsg("system", `Connected to agent (model: ${evt.model || tab.model})`)];
              break;

            case "ready":
              updated.isConnected = true;
              updated.messages = [...tab.messages, makeMsg("system", evt.message || "Agent ready.")];
              break;

            case "session_end":
              updated.isConnected = false;
              updated.isProcessing = false;
              updated.messages = [...tab.messages, makeMsg("system", `Session ended: ${evt.reason || "process exited"}`)];
              break;

            case "text":
              if (evt.content) {
                updated.streamingText = (tab.streamingText || "") + evt.content + "\n";
              }
              break;

            case "thinking":
              if (evt.content) {
                updated.streamingText = (tab.streamingText || "") + evt.content;
              }
              break;

            case "message":
            case "assistant_message": {
              const msgs = [...tab.messages];
              if (tab.streamingText.trim()) {
                msgs.push(makeMsg("assistant", tab.streamingText.trim()));
              }
              const content = evt.content || "";
              if (content) {
                msgs.push(makeMsg("assistant", content));
              }
              updated.messages = msgs;
              updated.streamingText = "";
              updated.isProcessing = false;
              break;
            }

            case "tool_start":
            case "tool_call":
              updated.messages = [...tab.messages, makeMsg("tool",
                `-> ${evt.toolName || evt.tool_name || "tool"}(${JSON.stringify(evt.input || evt.args || {}).slice(0, 120)})`)];
              break;

            case "tool_end":
            case "tool_result":
              if (evt.resultPreview || evt.result_preview) {
                updated.messages = [...tab.messages, makeMsg("tool",
                  `<- ${evt.toolName || evt.tool_name || "tool"}: ${(evt.resultPreview || evt.result_preview || "").slice(0, 200)}`)];
              }
              break;

            case "error":
              updated.isProcessing = false;
              updated.messages = [...tab.messages, makeMsg("error", evt.message || "Unknown error")];
              break;

            case "stderr":
              console.warn(`[agent stderr] ${evt.content}`);
              break;

            case "step":
            case "evidence":
            case "evidence_summary":
              break;

            default:
              if (evt.content) {
                updated.streamingText = (tab.streamingText || "") + evt.content;
              }
              break;
          }

          const newTabs = [...prevTabs];
          newTabs[tabIdx] = updated;
          return newTabs;
        });
      }) as unknown as () => void;

      // Welcome + create initial session
      addMsgToTab(initialTabId, "system", "8gent CLUI -- The Infinite Gentleman");
      connectTab(initialTabId);
    }

    init();
    return () => { unlisten?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Submit handler ────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !activeTab) return;
    const text = input.trim();
    setInput("");
    const tabId = activeTab.id;

    // ── Slash commands ──
    if (text.startsWith("/")) {
      const parts = text.slice(1).split(/\s+/);
      const cmd = parts[0]?.toLowerCase() || "";
      const args = parts.slice(1).join(" ");

      switch (cmd) {
        case "connect":
        case "conn":
          connectTab(tabId);
          break;

        case "debug":
        case "d":
          addMsgToTab(tabId, "system", [
            `IS_TAURI: ${IS_TAURI}`,
            `sessionId: ${activeTab.sessionId}`,
            `isConnected: ${activeTab.isConnected}`,
            `model: ${activeTab.model}`,
            `tabs: ${tabs.length}`,
            `window.location: ${window.location.href}`,
          ].join("\n"));
          break;

        case "theme":
        case "t": {
          const arg = args.toLowerCase();
          if (arg === "light" || arg === "dark" || arg === "system") {
            setThemeMode(arg);
            addMsgToTab(tabId, "system", `Theme set to: ${arg}`);
          } else {
            addMsgToTab(tabId, "system", "Usage: /theme dark|light|system");
          }
          break;
        }

        case "model":
        case "m": {
          const modelName = args.trim();
          if (!modelName) {
            addMsgToTab(tabId, "system", `Current model: ${activeTab.model}\nUsage: /model <name> (e.g. /model qwen3.5, /model eight:latest)`);
            break;
          }
          // Close existing session
          if (activeTab.sessionId) {
            try { await invoke("close_session", { sessionId: activeTab.sessionId }); } catch {}
          }
          updateTab(tabId, () => ({ sessionId: null, isConnected: false, isProcessing: false, streamingText: "" }));
          addMsgToTab(tabId, "system", `Switching to model: ${modelName}`);
          // Connect with new model after state settles
          setTimeout(() => connectTab(tabId, modelName), 50);
          break;
        }

        case "clear":
        case "cls":
          updateTab(tabId, () => ({ messages: [], streamingText: "" }));
          break;

        case "status":
        case "s":
          addMsgToTab(tabId, "system", [
            "Session Status",
            `  Model:      ${activeTab.model}`,
            `  Session ID: ${activeTab.sessionId || "(none)"}`,
            `  Connected:  ${activeTab.isConnected ? "Yes" : "No"}`,
            `  Tauri:      ${IS_TAURI ? "Yes" : "No (browser preview)"}`,
            `  Theme:      ${themeMode}`,
            `  Messages:   ${activeTab.messages.length}`,
            `  Tabs:       ${tabs.length}`,
          ].join("\n"));
          break;

        case "help":
        case "h":
        case "?":
          addMsgToTab(tabId, "system", [
            "Commands:",
            "  /connect      Retry agent connection",
            "  /model <name> Switch model (e.g. /model qwen3.5)",
            "  /theme <mode> Set theme (dark|light|system)",
            "  /status       Show session info",
            "  /debug        Show debug info",
            "  /clear        Clear messages",
            "  /help         This help",
            "",
            "Shortcuts:",
            "  Cmd+Shift+T   Cycle theme",
          ].join("\n"));
          break;

        default:
          addMsgToTab(tabId, "system", `Unknown command: /${cmd}. Type /help for available commands.`);
          break;
      }
      inputRef.current?.focus();
      return;
    }

    // ── Normal message ──
    addMsgToTab(tabId, "user", text);

    if (IS_TAURI && activeTab.sessionId) {
      updateTab(tabId, () => ({ isProcessing: true, streamingText: "" }));
      try {
        await invoke("send_to_agent", { sessionId: activeTab.sessionId, content: text });
      } catch (err: any) {
        const errMsg = typeof err === "string" ? err : err?.message || JSON.stringify(err);
        addMsgToTab(tabId, "error", `Failed to send: ${errMsg}`);
        updateTab(tabId, () => ({ isProcessing: false }));
      }
    } else if (IS_TAURI && !activeTab.sessionId) {
      addMsgToTab(tabId, "error", "No active session. Type /connect to create one.");
    } else {
      setTimeout(() => {
        addMsgToTab(tabId, "assistant", `[Preview mode] Received: "${text}". Launch in Tauri for real agent.`);
      }, 300);
    }

    inputRef.current?.focus();
  }

  // ── Tab management ────────────────────────────────────────────
  function handleNewTab() {
    const model = activeTab?.model ?? defaultModel;
    const newTab = createTab(model);
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
    if (IS_TAURI) {
      setTimeout(() => {
        addMsgToTab(newTab.id, "system", "8gent CLUI -- New Session");
        connectTab(newTab.id);
      }, 50);
    }
  }

  function handleCloseTab(tabId: string) {
    if (tabs.length <= 1) return;
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && IS_TAURI) {
      invoke("close_session", { sessionId: tab.sessionId }).catch(() => {});
    }
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId && filtered.length > 0) {
        setActiveTabId(filtered[filtered.length - 1].id);
      }
      return filtered;
    });
  }

  function handleStop() {
    if (!activeTab) return;
    if (activeTab.streamingText.trim()) {
      addMsgToTab(activeTab.id, "assistant", activeTab.streamingText.trim());
    }
    updateTab(activeTab.id, () => ({ isProcessing: false, streamingText: "" }));
  }

  const themeLabel = themeMode === "system" ? `${getSystemTheme()}` : themeMode;

  function roleColor(role: Message["role"]): string {
    switch (role) {
      case "user": return t.yellow;
      case "assistant": return t.magenta;
      case "tool": return t.blue;
      case "error": return t.red;
      default: return t.cyan;
    }
  }
  function roleLabel(role: Message["role"]): string {
    switch (role) {
      case "user": return "You";
      case "assistant": return "8gent";
      case "tool": return "Tool";
      case "error": return "Error";
      default: return "System";
    }
  }

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
          <span style={{ color: t.cyan, fontWeight: "bold" }}>&#8734;</span>
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
            {isDark ? "\u25D0" : "\u25D1"} {themeLabel}
          </button>
          <span style={{
            padding: "2px 8px", borderRadius: "4px", fontSize: "10px",
            backgroundColor: t.bgElevated, border: `1px solid ${t.border}`,
            color: activeTab?.isConnected ? t.green : t.textMuted,
          }}>
            {activeTab?.isConnected ? "\u25CF Connected" : "\u25CB Disconnected"}
          </span>
        </div>
      </div>

      {/* Tab Bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: "2px",
        padding: "4px 8px", backgroundColor: t.bgSecondary,
        borderBottom: `1px solid ${t.border}`,
        overflowX: "auto",
      }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "4px 12px", borderRadius: "4px 4px 0 0",
              backgroundColor: tab.id === activeTabId ? t.bg : "transparent",
              color: tab.id === activeTabId ? t.text : t.textMuted,
              fontSize: "11px",
              border: tab.id === activeTabId ? `1px solid ${t.border}` : "1px solid transparent",
              borderBottom: "none",
              cursor: "pointer",
              userSelect: "none",
              transition: "background-color 150ms",
            }}>
            <span style={{ color: tab.isConnected ? t.green : t.textMuted, fontSize: "8px" }}>
              {tab.isConnected ? "\u25CF" : "\u25CB"}
            </span>
            <span>{tab.label || "New Session"}</span>
            {tabs.length > 1 && (
              <span
                onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.id); }}
                style={{
                  color: t.textMuted, cursor: "pointer", fontSize: "12px",
                  marginLeft: "4px", lineHeight: 1,
                }}
                title="Close tab"
              >
                x
              </span>
            )}
          </div>
        ))}
        <button
          onClick={handleNewTab}
          style={{
            padding: "4px 8px", background: "none", border: "none",
            color: t.textMuted, cursor: "pointer", fontSize: "14px", fontFamily: "inherit",
          }}
          title="New session tab"
        >+</button>
      </div>

      {/* Message Area */}
      <div style={{
        flex: 1, overflow: "auto", padding: "16px",
        display: "flex", flexDirection: "column", gap: "8px",
      }}>
        {activeTab?.messages.map((msg) => (
          <div key={msg.id} style={{
            padding: "8px 12px", borderRadius: "6px",
            backgroundColor: msg.role === "user" ? t.userBubble : "transparent",
            borderLeft: `2px solid ${roleColor(msg.role)}`,
            transition: "background-color 200ms",
          }}>
            <span style={{
              color: roleColor(msg.role),
              fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px",
            }}>
              {roleLabel(msg.role)}
            </span>
            <div style={{
              marginTop: "4px", lineHeight: "1.6", whiteSpace: "pre-wrap",
              color: msg.role === "error" ? t.red : t.text,
            }}>
              {msg.content}
            </div>
          </div>
        ))}

        {/* Streaming text */}
        {activeTab?.streamingText && (
          <div style={{
            padding: "8px 12px", borderRadius: "6px",
            borderLeft: `2px solid ${t.magenta}`,
            opacity: 0.8,
          }}>
            <span style={{ color: t.magenta, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              8gent
            </span>
            <div style={{ marginTop: "4px", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>
              {activeTab.streamingText}
            </div>
          </div>
        )}

        {/* Processing indicator */}
        {activeTab?.isProcessing && !activeTab?.streamingText && (
          <div style={{ padding: "8px 12px", color: t.textMuted }}>
            <span style={{ color: t.cyan }}>...</span> Agent is thinking...
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
        <span style={{ color: t.cyan, paddingTop: "2px" }}>&gt;</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={activeTab?.isProcessing ? "Agent is working..." : "Ask 8gent anything... (/help for commands)"}
          disabled={activeTab?.isProcessing}
          autoFocus
          style={{
            flex: 1, background: "none", border: "none", outline: "none",
            color: t.text, fontFamily: "inherit", fontSize: "13px",
            opacity: activeTab?.isProcessing ? 0.5 : 1,
            transition: "color 200ms",
          }}
        />
        {activeTab?.isProcessing && (
          <button
            type="button"
            onClick={handleStop}
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
          <span><span style={{ color: t.green }}>&gt;&gt;</span> {activeTab?.model ?? defaultModel}</span>
          <span>| {tabs.filter((t) => t.isConnected).length}/{tabs.length} sessions</span>
          {!IS_TAURI && <span style={{ color: t.red }}>| Browser Preview</span>}
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <span>/help for commands</span>
        </div>
      </div>
    </div>
  );
}
