/**
 * 8gent CLUI — Main Application Shell
 * Fully wired: Tauri IPC -> Rust AgentManager -> Bun subprocess -> NDJSON events
 *
 * Redesigned: Polished pitch-ready UI with AgentCards, ToolCallRows, MemoryRows,
 * EvidenceSummary, AgentModeBar, ShortcutsBar.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ── Tauri Detection ─────────────────────────────────────────────
const IS_TAURI = !!(window as any).__TAURI_INTERNALS__;
const tauriWindow = IS_TAURI ? getCurrentWindow() : null;

// ── Theme System ────────────────────────────────────────────────
const themes = {
  dark: {
    bg: "#0c0e14", bgSecondary: "#10121c", bgElevated: "#1a1d2e",
    text: "#e2e4ef", textSecondary: "#8b8fa3", textMuted: "#5c6078",
    border: "#2a2d3e", borderFocus: "#06b6d4",
    cyan: "#06b6d4", magenta: "#a855f7", yellow: "#eab308",
    green: "#22c55e", red: "#ef4444", blue: "#3b82f6",
    userBubble: "#1a1d2e",
    // New extended tokens
    cardBg: "#111422", cardBorder: "#1e2136",
    toolRowBg: "#161830", toolRowBorder: "#242745",
    memoryBg: "#1a1230", memoryBorder: "#2d1f4e",
    evidenceBg: "#0f1f18", evidenceBorder: "#1a3d2e",
    inputBg: "#111422", inputBorderColor: "#2a2d3e",
    statusBarBg: "#0a0c12", modeBarBg: "#0e1018",
    headerBg: "#10121c", headerBorder: "#06b6d4",
    shortcutKey: "#5c6078", shortcutLabel: "#3d405a",
    badgeBg: "#1a1d2e",
  },
  light: {
    bg: "#f8f9fc", bgSecondary: "#eef0f5", bgElevated: "#ffffff",
    text: "#1a1d2e", textSecondary: "#5c6078", textMuted: "#8b8fa3",
    border: "#d1d5e0", borderFocus: "#0891b2",
    cyan: "#0891b2", magenta: "#9333ea", yellow: "#ca8a04",
    green: "#16a34a", red: "#dc2626", blue: "#2563eb",
    userBubble: "#eef0f5",
    // New extended tokens
    cardBg: "#ffffff", cardBorder: "#e2e5ee",
    toolRowBg: "#f2f4f8", toolRowBorder: "#d8dbe6",
    memoryBg: "#f5f0ff", memoryBorder: "#ddd0f5",
    evidenceBg: "#eefbf3", evidenceBorder: "#c2ebd2",
    inputBg: "#ffffff", inputBorderColor: "#d1d5e0",
    statusBarBg: "#eef0f5", modeBarBg: "#f0f2f7",
    headerBg: "#eef0f5", headerBorder: "#0891b2",
    shortcutKey: "#8b8fa3", shortcutLabel: "#aab0c0",
    badgeBg: "#eef0f5",
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

// ── Greetings ───────────────────────────────────────────────────
const GREETINGS = [
  "Splendid to see you.",
  "At your service, as always.",
  "Ready when you are, sir.",
  "The infinite gentleman awaits.",
  "Another fine session begins.",
  "Let's build something extraordinary.",
  "Your wish is my command line.",
  "Shall we begin?",
];
function randomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

// ── Agent Modes ─────────────────────────────────────────────────
type AgentMode = "Planning" | "Researching" | "Implementing" | "Testing" | "Debugging";
const AGENT_MODES: AgentMode[] = ["Planning", "Researching", "Implementing", "Testing", "Debugging"];

// ── Message Types ───────────────────────────────────────────────
interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool" | "error" | "memory" | "evidence";
  content: string;
  timestamp: number;
  meta?: {
    toolName?: string;
    duration?: number;
    filePath?: string;
    filesModified?: number;
    testsPassing?: number;
    memoryLabel?: string;
  };
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
  agentMode: AgentMode;
  tokenCount: number;
  startTime: number;
  branch: string;
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
    agentMode: "Planning",
    tokenCount: 0,
    startTime: Date.now(),
    branch: "main",
  };
}

function makeMsg(role: Message["role"], content: string, meta?: Message["meta"]): Message {
  return { id: makeId(), role, content, timestamp: Date.now(), meta };
}

function formatElapsed(startTime: number): string {
  const s = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ── Grouped messages for card rendering ─────────────────────────
interface MessageGroup {
  type: "user" | "agent" | "system" | "greeting";
  messages: Message[];
  streamingText?: string;
  isProcessing?: boolean;
  agentMode?: AgentMode;
}

function groupMessages(messages: Message[], streamingText: string, isProcessing: boolean, agentMode: AgentMode): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentAgent: Message[] | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentAgent) {
        groups.push({ type: "agent", messages: currentAgent, agentMode });
        currentAgent = null;
      }
      groups.push({ type: "user", messages: [msg] });
    } else if (msg.role === "system") {
      if (currentAgent) {
        groups.push({ type: "agent", messages: currentAgent, agentMode });
        currentAgent = null;
      }
      groups.push({ type: "system", messages: [msg] });
    } else {
      // assistant, tool, error, memory, evidence → group into agent card
      if (!currentAgent) currentAgent = [];
      currentAgent.push(msg);
    }
  }

  if (currentAgent) {
    groups.push({
      type: "agent", messages: currentAgent,
      streamingText, isProcessing, agentMode,
    });
  } else if (streamingText || isProcessing) {
    groups.push({
      type: "agent", messages: [],
      streamingText, isProcessing, agentMode,
    });
  }

  return groups;
}

// ══════════════════════════════════════════════════════════════════
// ── Sub-Components (inline) ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function GreetingMessage({ t, greeting }: { t: Theme; greeting: string }) {
  return (
    <div style={{
      display: "flex", justifyContent: "center", alignItems: "center",
      padding: "40px 20px 24px", userSelect: "none",
    }}>
      <span style={{
        color: t.textSecondary, fontSize: "15px", fontStyle: "italic",
        letterSpacing: "0.3px",
      }}>
        {greeting}
      </span>
    </div>
  );
}

function UserMessageBubble({ msg, t }: { msg: Message; t: Theme }) {
  return (
    <div style={{
      display: "flex", justifyContent: "flex-end", padding: "4px 0",
    }}>
      <div style={{
        maxWidth: "75%", padding: "10px 16px",
        borderRadius: "12px 12px 4px 12px",
        backgroundColor: t.userBubble,
        border: `1px solid ${t.green}33`,
        color: t.text, lineHeight: "1.6", whiteSpace: "pre-wrap",
        fontSize: "13px",
      }}>
        {msg.content}
      </div>
    </div>
  );
}

function ToolCallRow({ msg, t }: { msg: Message; t: Theme }) {
  const toolName = msg.meta?.toolName || "";
  const filePath = msg.meta?.filePath || "";
  const duration = msg.meta?.duration;
  const isResult = msg.content.startsWith("<-");
  const label = toolName || (isResult ? msg.content.slice(3, msg.content.indexOf(":")) : msg.content.slice(3));

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px",
      padding: "6px 10px", margin: "3px 0",
      backgroundColor: t.toolRowBg,
      border: `1px solid ${t.toolRowBorder}`,
      borderRadius: "8px", fontSize: "11px",
    }}>
      <span style={{ color: t.cyan, flexShrink: 0 }}>
        {isResult ? "\u2190" : "\u25B8"}
      </span>
      <span style={{
        color: t.textSecondary, flex: 1,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {isResult ? msg.content.slice(3).trim() : msg.content.slice(3).trim()}
      </span>
      {duration != null && (
        <span style={{
          color: t.textMuted, fontSize: "10px",
          padding: "1px 6px", borderRadius: "4px",
          backgroundColor: t.badgeBg,
          flexShrink: 0,
        }}>
          {duration}ms
        </span>
      )}
    </div>
  );
}

function MemoryRow({ msg, t }: { msg: Message; t: Theme }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px",
      padding: "6px 10px", margin: "3px 0",
      backgroundColor: t.memoryBg,
      border: `1px solid ${t.memoryBorder}`,
      borderRadius: "8px", fontSize: "11px",
    }}>
      <span style={{ color: t.magenta }}>●</span>
      <span style={{ color: t.magenta, fontWeight: 600, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        memory
      </span>
      <span style={{ color: t.textSecondary, flex: 1 }}>
        {msg.content}
      </span>
    </div>
  );
}

function EvidenceSummaryRow({ msg, t }: { msg: Message; t: Theme }) {
  const filesModified = msg.meta?.filesModified ?? 0;
  const testsPassing = msg.meta?.testsPassing ?? 0;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "8px",
      padding: "8px 10px", margin: "4px 0 0 0",
      backgroundColor: t.evidenceBg,
      border: `1px solid ${t.evidenceBorder}`,
      borderRadius: "8px", fontSize: "11px",
    }}>
      <span style={{ color: t.green }}>&#10003;</span>
      <span style={{ color: t.green }}>
        {filesModified > 0 ? `${filesModified} files modified` : ""}
        {filesModified > 0 && testsPassing > 0 ? " \u00B7 " : ""}
        {testsPassing > 0 ? `${testsPassing} tests passing` : ""}
        {filesModified === 0 && testsPassing === 0 ? msg.content : ""}
      </span>
      <span style={{
        marginLeft: "auto", padding: "1px 8px", borderRadius: "4px",
        backgroundColor: `${t.green}22`, color: t.green,
        fontSize: "10px", fontWeight: 600,
      }}>
        evidence
      </span>
    </div>
  );
}

function AgentCard({ group, t }: { group: MessageGroup; t: Theme }) {
  const assistantMsgs = group.messages.filter((m) => m.role === "assistant");
  const toolMsgs = group.messages.filter((m) => m.role === "tool");
  const errorMsgs = group.messages.filter((m) => m.role === "error");
  const memoryMsgs = group.messages.filter((m) => m.role === "memory");
  const evidenceMsgs = group.messages.filter((m) => m.role === "evidence");

  const modeLabel = group.agentMode || "Planning";
  const modeColor = modeLabel === "Planning" ? t.cyan
    : modeLabel === "Researching" ? t.blue
    : modeLabel === "Implementing" ? t.green
    : modeLabel === "Testing" ? t.yellow
    : t.red;

  const hasContent = group.messages.length > 0 || group.streamingText || group.isProcessing;
  if (!hasContent) return null;

  return (
    <div style={{
      padding: "0", margin: "6px 0",
      backgroundColor: t.cardBg,
      border: `1px solid ${t.cardBorder}`,
      borderLeft: `3px solid ${modeColor}`,
      borderRadius: "12px",
      overflow: "hidden",
    }}>
      {/* Mode indicator */}
      <div style={{
        display: "flex", alignItems: "center", gap: "8px",
        padding: "10px 14px 6px",
      }}>
        <span style={{
          color: modeColor, fontSize: "10px", fontWeight: 700,
          textTransform: "uppercase", letterSpacing: "0.8px",
        }}>
          {group.isProcessing ? `${modeLabel}...` : modeLabel}
        </span>
        {group.isProcessing && (
          <span style={{ color: modeColor, fontSize: "10px", animation: "pulse 1.5s infinite" }}>
            &#9679;
          </span>
        )}
      </div>

      {/* Assistant text content */}
      <div style={{ padding: "4px 14px 8px" }}>
        {assistantMsgs.map((msg) => (
          <div key={msg.id} style={{
            color: t.text, lineHeight: "1.65", whiteSpace: "pre-wrap",
            fontSize: "13px", marginBottom: "4px",
          }}>
            {msg.content}
          </div>
        ))}

        {/* Streaming text */}
        {group.streamingText && (
          <div style={{
            color: t.text, lineHeight: "1.65", whiteSpace: "pre-wrap",
            fontSize: "13px", opacity: 0.85,
          }}>
            {group.streamingText}
          </div>
        )}

        {/* Processing with no text yet */}
        {group.isProcessing && !group.streamingText && assistantMsgs.length === 0 && (
          <div style={{ color: t.textMuted, fontSize: "12px", padding: "4px 0" }}>
            <span style={{ color: t.cyan }}>&#8943;</span> Thinking...
          </div>
        )}

        {/* Error messages */}
        {errorMsgs.map((msg) => (
          <div key={msg.id} style={{
            color: t.red, fontSize: "12px", padding: "4px 0",
            lineHeight: "1.5",
          }}>
            {msg.content}
          </div>
        ))}
      </div>

      {/* Tool calls */}
      {toolMsgs.length > 0 && (
        <div style={{ padding: "0 14px 6px" }}>
          {toolMsgs.map((msg) => (
            <ToolCallRow key={msg.id} msg={msg} t={t} />
          ))}
        </div>
      )}

      {/* Memory rows */}
      {memoryMsgs.length > 0 && (
        <div style={{ padding: "0 14px 6px" }}>
          {memoryMsgs.map((msg) => (
            <MemoryRow key={msg.id} msg={msg} t={t} />
          ))}
        </div>
      )}

      {/* Evidence summary */}
      {evidenceMsgs.length > 0 && (
        <div style={{ padding: "0 14px 10px" }}>
          {evidenceMsgs.map((msg) => (
            <EvidenceSummaryRow key={msg.id} msg={msg} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function SystemMessage({ msg, t }: { msg: Message; t: Theme }) {
  return (
    <div style={{
      padding: "6px 14px", margin: "2px 0",
      fontSize: "11px", lineHeight: "1.5",
      color: t.textMuted, whiteSpace: "pre-wrap",
    }}>
      {msg.content}
    </div>
  );
}

function StatusBar({ t, tab, tabs, themeMode, defaultModel, elapsed }: {
  t: Theme; tab: TabState | undefined; tabs: TabState[];
  themeMode: ThemeMode; defaultModel: string; elapsed: string;
}) {
  const model = tab?.model ?? defaultModel;
  const connectedCount = tabs.filter((t) => t.isConnected).length;
  const mode = tab?.isProcessing ? "Act Mode" : "Ask Mode";

  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "5px 16px",
      backgroundColor: t.statusBarBg,
      borderTop: `1px solid ${t.border}`,
      fontSize: "10px", color: t.textMuted,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      userSelect: "none",
    }}>
      <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
        <span style={{ color: t.cyan, fontWeight: 600 }}>{model}</span>
        <span>{connectedCount}/{tabs.length} agents</span>
        <span style={{ color: tab?.isProcessing ? t.yellow : t.cyan }}>
          {tab?.isProcessing ? "\u26A1" : "?"} {mode}
        </span>
      </div>
      <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
        {!IS_TAURI && <span style={{ color: t.red }}>Browser Preview</span>}
        <span style={{ color: t.green }}>{tab?.branch || "main"}</span>
        <span>{elapsed}</span>
      </div>
    </div>
  );
}

function AgentModeBar({ t, activeMode }: { t: Theme; activeMode: AgentMode }) {
  return (
    <div style={{
      display: "flex", justifyContent: "center", gap: "4px",
      padding: "4px 16px",
      backgroundColor: t.modeBarBg,
      fontSize: "10px", userSelect: "none",
    }}>
      {AGENT_MODES.map((mode) => {
        const isActive = mode === activeMode;
        const color = mode === "Planning" ? t.cyan
          : mode === "Researching" ? t.blue
          : mode === "Implementing" ? t.green
          : mode === "Testing" ? t.yellow
          : t.red;
        return (
          <span key={mode} style={{
            padding: "2px 10px", borderRadius: "4px",
            color: isActive ? color : t.textMuted,
            backgroundColor: isActive ? `${color}18` : "transparent",
            fontWeight: isActive ? 700 : 400,
            transition: "all 150ms",
          }}>
            {isActive ? `[${mode}]` : mode}
          </span>
        );
      })}
    </div>
  );
}

function ShortcutsBar({ t }: { t: Theme }) {
  const shortcuts = [
    { key: "^O", label: "expand" },
    { key: "^B", label: "processes" },
    { key: "^K", label: "kanban" },
    { key: "^P", label: "predict" },
    { key: "^C", label: "exit" },
  ];
  return (
    <div style={{
      display: "flex", justifyContent: "center", gap: "16px",
      padding: "4px 16px",
      fontSize: "10px", userSelect: "none",
    }}>
      {shortcuts.map((s) => (
        <span key={s.key}>
          <span style={{ color: t.shortcutKey, fontWeight: 600 }}>{s.key}</span>
          <span style={{ color: t.shortcutLabel, marginLeft: "3px" }}>{s.label}</span>
        </span>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// ── Main App ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

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
  const initDone = useRef(false);
  const [greeting] = useState(randomGreeting);
  const [elapsed, setElapsed] = useState("0:00");

  const t = resolveTheme(themeMode);
  const isDark = t === (themes.dark as Theme);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  // Elapsed timer
  useEffect(() => {
    const interval = setInterval(() => {
      if (activeTab) setElapsed(formatElapsed(activeTab.startTime));
    }, 1000);
    return () => clearInterval(interval);
  }, [activeTab?.startTime]);

  // ── Tab state helpers ────
  const updateTab = useCallback((tabId: string, updater: (tab: TabState) => Partial<TabState>) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, ...updater(tab) } : tab))
    );
  }, []);

  const addMsgToTab = useCallback((tabId: string, role: Message["role"], content: string, meta?: Message["meta"]) => {
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId ? { ...tab, messages: [...tab.messages, makeMsg(role, content, meta)] } : tab
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

  // Inject keyframes for pulse animation
  useEffect(() => {
    const styleId = "8gent-keyframes";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        input::placeholder { color: inherit; opacity: 0.4; }
        *::-webkit-scrollbar { width: 6px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: ${t.border}; border-radius: 3px; }
        *::-webkit-scrollbar-thumb:hover { background: ${t.textMuted}; }
      `;
      document.head.appendChild(style);
    }
  }, [t.border, t.textMuted]);

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
        isConnected: true,
      }));
      addMsgToTab(tabId, "system", `Session ${sidStr} connected. Agent ready.`);
    } catch (err: any) {
      const errMsg = typeof err === "string" ? err : err?.message || JSON.stringify(err);
      addMsgToTab(tabId, "error", `Session creation failed: ${errMsg}`);
      addMsgToTab(tabId, "system", "Type /connect to retry, or /debug for diagnostics.");
    }
  }, [addMsgToTab, updateTab, defaultModel]);

  // ── Initialize Tauri + event listener ─────────────
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    let unlisten: (() => void) | null = null;
    const initialTabId = tabs[0]?.id;

    async function init() {
      if (!IS_TAURI) {
        addMsgToTab(initialTabId, "system", "8gent CLUI — The Infinite Gentleman\nRunning in browser preview mode (no Tauri).\nLaunch via `cargo tauri dev` for full agent.\nTip: Cmd+Shift+T to toggle theme");
        return;
      }

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
                updated.agentMode = "Planning";
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
            case "tool_call": {
              const toolName = evt.toolName || evt.tool_name || "tool";
              const inputStr = JSON.stringify(evt.input || evt.args || {}).slice(0, 120);
              updated.messages = [...tab.messages, makeMsg("tool",
                `-> ${toolName}(${inputStr})`,
                { toolName, filePath: evt.input?.path || evt.input?.file_path })];
              updated.agentMode = "Implementing";
              break;
            }

            case "tool_end":
            case "tool_result": {
              const toolName = evt.toolName || evt.tool_name || "tool";
              if (evt.resultPreview || evt.result_preview) {
                updated.messages = [...tab.messages, makeMsg("tool",
                  `<- ${toolName}: ${(evt.resultPreview || evt.result_preview || "").slice(0, 200)}`,
                  { toolName, duration: evt.duration })];
              }
              break;
            }

            case "error":
              updated.isProcessing = false;
              updated.agentMode = "Debugging";
              updated.messages = [...tab.messages, makeMsg("error", evt.message || "Unknown error")];
              break;

            case "stderr":
              console.warn(`[agent stderr] ${evt.content}`);
              break;

            case "step":
              break;

            case "evidence":
            case "evidence_summary":
              updated.messages = [...tab.messages, makeMsg("evidence",
                evt.summary || evt.content || "Evidence collected",
                { filesModified: evt.files_modified, testsPassing: evt.tests_passing })];
              break;

            case "memory":
            case "memory_recall":
              updated.messages = [...tab.messages, makeMsg("memory",
                evt.content || evt.description || "Memory recalled",
                { memoryLabel: evt.label })];
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

      addMsgToTab(initialTabId, "system", "8gent CLUI — The Infinite Gentleman");
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
          if (activeTab.sessionId) {
            try { await invoke("close_session", { sessionId: activeTab.sessionId }); } catch {}
          }
          updateTab(tabId, () => ({ sessionId: null, isConnected: false, isProcessing: false, streamingText: "" }));
          addMsgToTab(tabId, "system", `Switching to model: ${modelName}`);
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
      updateTab(tabId, () => ({ isProcessing: true, streamingText: "", agentMode: "Planning" as AgentMode }));
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
        addMsgToTab(newTab.id, "system", "8gent CLUI — New Session");
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

  // Group messages for card rendering
  const messageGroups = useMemo(() => {
    if (!activeTab) return [];
    return groupMessages(
      activeTab.messages,
      activeTab.streamingText,
      activeTab.isProcessing,
      activeTab.agentMode,
    );
  }, [activeTab?.messages, activeTab?.streamingText, activeTab?.isProcessing, activeTab?.agentMode]);

  // Token estimate (rough: ~4 chars per token)
  const tokenEstimate = useMemo(() => {
    if (!activeTab) return 0;
    const totalChars = activeTab.messages.reduce((acc, m) => acc + m.content.length, 0) + (activeTab.streamingText?.length || 0);
    return Math.round(totalChars / 4);
  }, [activeTab?.messages, activeTab?.streamingText]);

  const tokenDisplay = tokenEstimate > 1000
    ? `${(tokenEstimate / 1000).toFixed(1)}K`
    : `${tokenEstimate}`;

  // ══════════════════════════════════════════════════════════════
  // ── RENDER ─────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh",
      backgroundColor: t.bg, color: t.text,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, monospace", fontSize: "13px",
      transition: "background-color 200ms, color 200ms",
    }}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div data-tauri-drag-region style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 20px",
        backgroundColor: t.headerBg,
        borderBottom: `2px solid ${t.headerBorder}`,
        userSelect: "none",
        transition: "background-color 200ms",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ color: t.cyan, fontWeight: "bold", fontSize: "16px" }}>&#8734;</span>
          <span style={{ color: t.cyan, fontWeight: 700, fontSize: "14px", letterSpacing: "0.5px" }}>
            8gent Code
          </span>
          <span style={{ color: t.textMuted, fontSize: "10px" }}>v0.6.0</span>
        </div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            onClick={() => setThemeMode((p) => (["dark", "light", "system"] as ThemeMode[])[(["dark", "light", "system"].indexOf(p) + 1) % 3])}
            title={`Theme: ${themeLabel} (Cmd+Shift+T)`}
            style={{
              padding: "3px 10px", borderRadius: "6px", fontSize: "10px",
              backgroundColor: t.badgeBg, color: t.yellow,
              border: `1px solid ${t.border}`, cursor: "pointer", fontFamily: "inherit",
            }}>
            {isDark ? "\u25D0" : "\u25D1"} {themeLabel}
          </button>
          <span style={{
            padding: "3px 10px", borderRadius: "6px", fontSize: "10px",
            backgroundColor: t.badgeBg, border: `1px solid ${t.border}`,
            color: activeTab?.isConnected ? t.green : t.textMuted,
          }}>
            {activeTab?.isConnected ? "\u25CF" : "\u25CB"} {activeTab?.isConnected ? "Connected" : "Disconnected"}
          </span>
          <span style={{
            color: t.textSecondary, fontSize: "11px", fontStyle: "italic",
          }}>
            The Infinite Gentleman
          </span>
        </div>
      </div>

      {/* ── Tab Bar ────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: "2px",
        padding: "4px 12px",
        backgroundColor: t.bgSecondary,
        borderBottom: `1px solid ${t.border}`,
        overflowX: "auto",
      }}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "5px 14px", borderRadius: "6px 6px 0 0",
              backgroundColor: tab.id === activeTabId ? t.bg : "transparent",
              color: tab.id === activeTabId ? t.text : t.textMuted,
              fontSize: "11px",
              border: tab.id === activeTabId ? `1px solid ${t.border}` : "1px solid transparent",
              borderBottom: "none",
              cursor: "pointer", userSelect: "none",
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
                  color: t.textMuted, cursor: "pointer", fontSize: "11px",
                  marginLeft: "4px", lineHeight: 1, opacity: 0.6,
                }}
                title="Close tab"
              >
                \u00D7
              </span>
            )}
          </div>
        ))}
        <button
          onClick={handleNewTab}
          style={{
            padding: "4px 10px", background: "none", border: "none",
            color: t.textMuted, cursor: "pointer", fontSize: "14px", fontFamily: "inherit",
          }}
          title="New session tab"
        >+</button>
      </div>

      {/* ── Message Area ───────────────────────────────────────── */}
      <div style={{
        flex: 1, overflow: "auto", padding: "12px 20px",
        display: "flex", flexDirection: "column", gap: "4px",
      }}>
        {/* Greeting */}
        <GreetingMessage t={t} greeting={greeting} />

        {/* Grouped messages */}
        {messageGroups.map((group, gi) => {
          if (group.type === "user") {
            return group.messages.map((msg) => (
              <UserMessageBubble key={msg.id} msg={msg} t={t} />
            ));
          }
          if (group.type === "system") {
            return group.messages.map((msg) => (
              <SystemMessage key={msg.id} msg={msg} t={t} />
            ));
          }
          if (group.type === "agent") {
            return <AgentCard key={`agent-${gi}`} group={group} t={t} />;
          }
          return null;
        })}

        {/* "Awaiting your command" when idle */}
        {!activeTab?.isProcessing && activeTab?.messages.length > 0 && (
          <div style={{
            padding: "12px 0 4px",
            color: t.textMuted, fontSize: "11px", fontStyle: "italic",
          }}>
            Awaiting your command...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input Bar ──────────────────────────────────────────── */}
      <form onSubmit={handleSubmit} style={{
        display: "flex", gap: "8px", padding: "10px 20px",
        borderTop: `1px solid ${t.border}`,
        backgroundColor: t.bgSecondary,
        alignItems: "center",
        transition: "background-color 200ms",
      }}>
        <div style={{
          display: "flex", flex: 1, alignItems: "center",
          backgroundColor: t.inputBg,
          border: `1px solid ${t.inputBorderColor}`,
          borderRadius: "10px",
          padding: "8px 14px",
          transition: "border-color 200ms",
        }}>
          <span style={{ color: t.cyan, marginRight: "8px", fontSize: "13px", fontWeight: 700 }}>
            &#9656;
          </span>
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
        </div>
        <div style={{
          padding: "8px 12px", borderRadius: "10px",
          backgroundColor: t.inputBg,
          border: `1px solid ${t.inputBorderColor}`,
          fontSize: "10px", color: t.textMuted,
          whiteSpace: "nowrap",
        }}>
          /{tokenDisplay} of 128K
        </div>
        {activeTab?.isProcessing && (
          <button
            type="button"
            onClick={handleStop}
            style={{
              padding: "6px 14px", borderRadius: "8px", fontSize: "11px",
              backgroundColor: t.red, color: "#fff", border: "none",
              cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
            }}
          >
            Stop
          </button>
        )}
      </form>

      {/* ── Status Bar ─────────────────────────────────────────── */}
      <StatusBar
        t={t}
        tab={activeTab}
        tabs={tabs}
        themeMode={themeMode}
        defaultModel={defaultModel}
        elapsed={elapsed}
      />

      {/* ── Agent Mode Bar ─────────────────────────────────────── */}
      <AgentModeBar t={t} activeMode={activeTab?.agentMode || "Planning"} />

      {/* ── Shortcuts Bar ──────────────────────────────────────── */}
      <ShortcutsBar t={t} />
    </div>
  );
}
