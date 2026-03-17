/**
 * 8gent CLUI -- Main Application Shell
 *
 * Layout:
 * +------------------------------------------------------------------+
 * | [drag region / title bar]                    [auth] [_] [x]      |
 * +------------------------------------------------------------------+
 * | [Tab 1] [Tab 2] [+]                                              |
 * +------------------------------------------------------------------+
 * |                                                     | Evidence   |
 * |                    Active Session Panel              | Panel      |
 * |   (MessageList + ThinkingView + CommandInput)        | (toggle)   |
 * |                                                     |            |
 * +------------------------------------------------------------------+
 * | [PlanKanban toggle view -- Cmd+K]                                 |
 * +------------------------------------------------------------------+
 * | StatusBar                                                         |
 * +------------------------------------------------------------------+
 *
 * Overlays: AuthGate (device code), SettingsPanel (Cmd+,)
 */

import React, { useEffect, useCallback } from "react";
import { AnimatePresence } from "framer-motion";
import { useSessionStore } from "./stores/session-store";
import { usePreferencesStore } from "./stores/preferences-store";
import { useAuthStore } from "./stores/auth-store";
import { MessageList } from "./components/MessageList";
import { StatusBar } from "./components/StatusBar";
import { AuthGate, AuthStatusBadge, DeviceCodeOverlay, AuthErrorToast } from "./components/AuthGate";
import { ThinkingView } from "./components/ThinkingView";
import { EvidencePanel } from "./components/EvidencePanel";
import { PlanKanban } from "./components/PlanKanban";
import { SettingsPanel } from "./components/SettingsPanel";
import { useConvexSync } from "./hooks/useConvexSync";

// ── Tab Bar ──────────────────────────────────────────────────────────

function TabBar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeSessionId);
  const switchTab = useSessionStore((s) => s.switchTab);
  const createSession = useSessionStore((s) => s.createSession);
  const closeSession = useSessionStore((s) => s.closeSession);

  return (
    <div className="flex items-center gap-0.5 bg-surface-secondary px-2 py-1 border-b border-subtle overflow-x-auto">
      {Object.values(sessions).map((session) => {
        const isActive = session.id === activeId;
        return (
          <button
            key={session.id}
            onClick={() => switchTab(session.id)}
            className={`
              group relative flex items-center gap-1.5 px-3 py-1 rounded-t text-xs
              transition-colors duration-150
              ${isActive
                ? "bg-surface-primary text-text-primary border border-b-0 border-subtle"
                : "text-muted hover:text-text-secondary hover:bg-surface-elevated"
              }
            `}
          >
            {/* Status dot */}
            <span
              className={`
                inline-block w-1.5 h-1.5 rounded-full
                ${session.status === "processing"
                  ? "bg-8-yellow animate-pulse-slow"
                  : session.status === "error"
                    ? "bg-8-red"
                    : "bg-8-green"
                }
              `}
            />

            {/* Tab label */}
            <span className="max-w-[120px] truncate">
              {session.label || `Session ${session.id.slice(0, 6)}`}
            </span>

            {/* Close button */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeSession(session.id);
              }}
              className="
                opacity-0 group-hover:opacity-100
                ml-1 text-muted hover:text-danger
                transition-opacity duration-150
              "
              aria-label={`Close session ${session.label}`}
            >
              x
            </button>
          </button>
        );
      })}

      {/* New tab button */}
      <button
        onClick={() => createSession()}
        className="
          flex items-center justify-center w-6 h-6
          text-muted hover:text-accent hover:bg-surface-elevated
          rounded transition-colors duration-150 text-sm
        "
        aria-label="New session"
      >
        +
      </button>
    </div>
  );
}

// ── Title Bar ────────────────────────────────────────────────────────

function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="
        flex items-center justify-between
        h-8 px-3
        bg-surface-secondary border-b border-subtle
        select-none
      "
    >
      {/* macOS traffic light spacer (left) */}
      <div className="w-16" />

      {/* Center: brand */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-accent font-bold">8gent</span>
        <span className="text-muted">CLUI</span>
      </div>

      {/* Right: auth status */}
      <div className="w-32 flex justify-end">
        <AuthStatusBadge />
      </div>
    </div>
  );
}

// ── Session Panel ────────────────────────────────────────────────────

function SessionPanel() {
  const activeId = useSessionStore((s) => s.activeSessionId);
  const session = useSessionStore((s) =>
    activeId ? s.sessions[activeId] : null,
  );
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const showEvidencePanel = usePreferencesStore((s) => s.showEvidencePanel);
  const toggleEvidencePanel = usePreferencesStore((s) => s.toggleEvidencePanel);

  const handleSubmit = useCallback(
    (text: string) => {
      if (activeId && text.trim()) {
        sendMessage(activeId, text.trim());
      }
    },
    [activeId, sendMessage],
  );

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-3xl mb-2 text-accent">8</div>
          <div className="text-muted text-sm">
            Press <kbd className="px-1 py-0.5 border border-subtle rounded text-accent">+</kbd> to start a new session
          </div>
        </div>
      </div>
    );
  }

  // Build evidence from tool calls for the panel
  const evidenceItems = session.toolCalls.map((tc) => ({
    type: "command_output" as const,
    description: `${tc.name}: ${tc.status}`,
    data: tc.output || "",
    timestamp: tc.startedAt,
    verified: tc.status === "complete",
    command: tc.name,
    duration: tc.completedAt
      ? tc.completedAt.getTime() - tc.startedAt.getTime()
      : undefined,
  }));

  return (
    <div className="flex-1 flex min-h-0">
      {/* Main session content */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Message area */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <MessageList messages={session.messages} />

          {/* Thinking view */}
          <AnimatePresence>
            {session.status === "processing" && (
              <ThinkingView
                processingStage={session.processingStage}
                activeTool={session.activeTool}
                stepCount={session.stepCount}
                toolCount={session.toolCount}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Command input */}
        <div className="border-t border-subtle px-4 py-2">
          <CommandInputBar
            onSubmit={handleSubmit}
            isProcessing={session.status === "processing"}
          />
        </div>
      </div>

      {/* Evidence panel sidebar */}
      <EvidencePanel
        evidence={evidenceItems}
        confidence={
          evidenceItems.length > 0
            ? Math.round(
                (evidenceItems.filter((e) => e.verified).length /
                  evidenceItems.length) *
                  100,
              )
            : undefined
        }
        isOpen={showEvidencePanel}
        onToggle={toggleEvidencePanel}
      />
    </div>
  );
}

// ── Command Input Bar ────────────────────────────────────────────────

interface CommandInputBarProps {
  onSubmit: (text: string) => void;
  isProcessing: boolean;
}

function CommandInputBar({ onSubmit, isProcessing }: CommandInputBarProps) {
  const [value, setValue] = React.useState("");

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey && value.trim()) {
        e.preventDefault();
        onSubmit(value.trim());
        setValue("");
      }
    },
    [value, onSubmit],
  );

  return (
    <div className="flex items-center gap-2">
      <span className="text-accent font-bold text-sm">&rsaquo;</span>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          isProcessing
            ? "Queue a follow-up message..."
            : "Type a command or ask a question..."
        }
        className="
          flex-1 bg-transparent outline-none
          text-text-primary placeholder:text-muted
          text-sm
        "
        autoFocus
      />
      {value.startsWith("/") && (
        <span className="text-info text-xs">slash command</span>
      )}
    </div>
  );
}

// ── Kanban Section ───────────────────────────────────────────────────

function KanbanSection() {
  const activeId = useSessionStore((s) => s.activeSessionId);
  const session = useSessionStore((s) =>
    activeId ? s.sessions[activeId] : null,
  );
  const showKanban = usePreferencesStore((s) => s.showKanban);
  const toggleKanban = usePreferencesStore((s) => s.toggleKanban);

  if (!session) return null;

  // Build plan steps from session tool calls
  const planSteps = session.toolCalls.map((tc) => ({
    id: tc.id,
    description: tc.name,
    tool: tc.name,
    category: "exploration" as const,
    priority: 5,
    confidence: tc.status === "complete" ? 1 : tc.status === "running" ? 0.5 : 0.3,
    status:
      tc.status === "complete" || tc.status === "failed"
        ? ("done" as const)
        : tc.status === "running"
          ? ("in_progress" as const)
          : ("planned" as const),
  }));

  return (
    <div className="px-4 pb-2">
      <PlanKanban
        steps={planSteps}
        visible={showKanban}
        onClose={toggleKanban}
        compact={planSteps.length > 12}
      />
    </div>
  );
}

// ── App Root ─────────────────────────────────────────────────────────

export function App() {
  const createSession = useSessionStore((s) => s.createSession);
  const sessions = useSessionStore((s) => s.sessions);
  const closeSession = useSessionStore((s) => s.closeSession);
  const switchTab = useSessionStore((s) => s.switchTab);
  const toggleKanban = usePreferencesStore((s) => s.toggleKanban);
  const toggleEvidencePanel = usePreferencesStore((s) => s.toggleEvidencePanel);
  const toggleSettings = usePreferencesStore((s) => s.toggleSettings);
  const showSettings = usePreferencesStore((s) => s.showSettings);
  const hydrate = usePreferencesStore((s) => s.hydrate);

  // Hydrate preferences from localStorage on mount
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Start Convex sync
  useConvexSync();

  // Create initial session if none exist
  useEffect(() => {
    if (Object.keys(sessions).length === 0) {
      createSession();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+T: new tab
      if (mod && e.key === "t") {
        e.preventDefault();
        createSession();
        return;
      }

      // Cmd+W: close current tab
      if (mod && e.key === "w") {
        e.preventDefault();
        const state = useSessionStore.getState();
        if (state.activeSessionId) {
          closeSession(state.activeSessionId);
        }
        return;
      }

      // Cmd+K: toggle kanban
      if (mod && e.key === "k") {
        e.preventDefault();
        toggleKanban();
        return;
      }

      // Cmd+E: toggle evidence panel
      if (mod && e.key === "e") {
        e.preventDefault();
        toggleEvidencePanel();
        return;
      }

      // Cmd+,: toggle settings
      if (mod && e.key === ",") {
        e.preventDefault();
        toggleSettings();
        return;
      }

      // Escape: close overlays
      if (e.key === "Escape") {
        const prefsState = usePreferencesStore.getState();
        if (prefsState.showSettings) {
          toggleSettings();
          return;
        }
        if (prefsState.showKanban) {
          toggleKanban();
          return;
        }
        if (prefsState.showEvidencePanel) {
          toggleEvidencePanel();
          return;
        }
      }

      // Cmd+1 through Cmd+9: switch to tab by index
      if (mod && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const state = useSessionStore.getState();
        const ids = Object.keys(state.sessions);
        const index = parseInt(e.key, 10) - 1;
        if (index < ids.length) {
          switchTab(ids[index]);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [createSession, closeSession, switchTab, toggleKanban, toggleEvidencePanel, toggleSettings]);

  return (
    <AuthGate>
      <div className="h-full flex flex-col bg-surface-primary">
        <TitleBar />
        <TabBar />
        <SessionPanel />
        <KanbanSection />
        <StatusBar />

        {/* Overlays */}
        <DeviceCodeOverlay />
        <AuthErrorToast />
        <SettingsPanel isOpen={showSettings} onClose={toggleSettings} />
      </div>
    </AuthGate>
  );
}
