/**
 * 8gent Code - Per-Tab Chat State Hook
 *
 * Manages independent chat state for each workspace tab.
 * Each chat tab gets its own messages array, Agent instance,
 * and processing state — enabling true parallel conversations.
 *
 * Agents run independently: switching tabs does NOT abort background agents.
 * Messages persist to ~/.8gent/tabs/chat-{tabId}.json on each update.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import * as fs from "fs";
import * as path from "path";
import { Agent } from "../../../../packages/eight/index.js";
import type {
  AgentToolStartEvent,
  AgentToolEndEvent,
  AgentStepEvent,
  AgentEvidenceEvent,
  AgentEvidenceSummaryEvent,
} from "../../../../packages/eight/index.js";
import type { Message } from "../app.js";

// ============================================
// Types
// ============================================

export interface ChatTabState {
  messages: Message[];
  agent: Agent | null;
  agentReady: boolean;
  isProcessing: boolean;
  status: string;
  activeTool: string | null;
  stepCount: number;
  toolCount: number;
  totalTokens: number;
}

interface TabStateEntry {
  state: ChatTabState;
  agentRunningRef: boolean;
  messageQueueRef: string[];
}

// ============================================
// Persistence
// ============================================

const TABS_DIR = path.join(process.env.HOME || "~", ".8gent", "tabs");

function ensureTabsDir() {
  try {
    if (!fs.existsSync(TABS_DIR)) {
      fs.mkdirSync(TABS_DIR, { recursive: true });
    }
  } catch {
    // Best-effort
  }
}

function persistMessages(tabId: string, messages: Message[]) {
  try {
    ensureTabsDir();
    const filePath = path.join(TABS_DIR, `chat-${tabId}.json`);
    // Serialize with date handling
    const serializable = messages.map((m) => ({
      ...m,
      timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
    }));
    fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), "utf-8");
  } catch {
    // Best-effort persistence
  }
}

function loadPersistedMessages(tabId: string): Message[] | null {
  try {
    const filePath = path.join(TABS_DIR, `chat-${tabId}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (Array.isArray(data) && data.length > 0) {
        return data.map((m: any) => ({
          ...m,
          timestamp: new Date(m.timestamp),
        }));
      }
    }
  } catch {
    // Corrupt file — start fresh
  }
  return null;
}

// ============================================
// Map provider string to runtime
// ============================================

function mapProviderToRuntime(provider: string): "ollama" | "lmstudio" | "openrouter" {
  if (provider === "lmstudio") return "lmstudio";
  if (provider === "openrouter" || provider === "openrouter-free") return "openrouter";
  return "ollama";
}

// ============================================
// Default welcome message
// ============================================

const GREETINGS = [
  "Good day. What shall we build?",
  "Ah, a new task. Excellent.",
  "Ready to craft something magnificent?",
  "At your service. What's the mission?",
  "\u221E The infinite gentleman awaits.",
  "Splendid to see you. Where shall we begin?",
];

function makeWelcomeMessage(): Message {
  const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  return {
    id: "welcome",
    role: "system",
    content: `\u221E 8gent Code - The Infinite Gentleman\n\n${greeting}\n\nTry /help for commands, Tab for suggestions, or just ask.`,
    timestamp: new Date(),
  };
}

// ============================================
// Hook
// ============================================

export function useChatTabState(
  tabId: string,
  model: string,
  provider: string
): {
  state: ChatTabState;
  addMessage: (msg: Message) => void;
  addSystemMessage: (content: string) => void;
  chat: (message: string, imageBase64?: string, imageMimeType?: string) => Promise<void>;
  abort: () => void;
  cleanup: () => void;
} {
  // Per-tab state stored in a Map ref so tab switches don't lose state
  const tabStatesRef = useRef<Map<string, TabStateEntry>>(new Map());
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Force re-render counter (bumped when active tab state changes)
  const [, setRenderTick] = useState(0);
  const forceRender = useCallback(() => setRenderTick((t) => t + 1), []);

  // Get or initialize state for a tab
  const getTabEntry = useCallback((tid: string): TabStateEntry => {
    const existing = tabStatesRef.current.get(tid);
    if (existing) return existing;

    // Try loading persisted messages
    const persisted = loadPersistedMessages(tid);
    const initialMessages = persisted || [makeWelcomeMessage()];

    const entry: TabStateEntry = {
      state: {
        messages: initialMessages,
        agent: null,
        agentReady: false,
        isProcessing: false,
        status: "idle",
        activeTool: null,
        stepCount: 0,
        toolCount: 0,
        totalTokens: 0,
      },
      agentRunningRef: false,
      messageQueueRef: [],
    };

    tabStatesRef.current.set(tid, entry);
    return entry;
  }, []);

  // Schedule debounced persistence for a tab
  const schedulePersist = useCallback((tid: string, messages: Message[]) => {
    const existing = saveTimersRef.current.get(tid);
    if (existing) clearTimeout(existing);
    saveTimersRef.current.set(
      tid,
      setTimeout(() => persistMessages(tid, messages), 500)
    );
  }, []);

  // Update a specific field in a tab's state and trigger re-render if it's the active tab
  const updateTabState = useCallback(
    (tid: string, partial: Partial<ChatTabState>) => {
      const entry = tabStatesRef.current.get(tid);
      if (!entry) return;
      Object.assign(entry.state, partial);
      // Only re-render if it's the currently active tab
      if (tid === tabId) {
        forceRender();
      }
    },
    [tabId, forceRender]
  );

  // Lazily create an Agent for a tab
  const ensureAgent = useCallback(
    async (tid: string): Promise<Agent | null> => {
      const entry = getTabEntry(tid);
      if (entry.state.agent && entry.state.agentReady) {
        return entry.state.agent;
      }

      try {
        const runtime = mapProviderToRuntime(provider);

        const newAgent = new Agent({
          model,
          runtime,
          workingDirectory: process.cwd(),
          maxTurns: 50,
          apiKey: process.env.OPENROUTER_API_KEY,
          events: {
            onToolStart: (event: AgentToolStartEvent) => {
              updateTabState(tid, {
                activeTool: event.toolName,
                status: "executing",
              });

              // Show tool call in message stream
              const argsPreview = JSON.stringify(event.args).slice(0, 80);
              const toolStartMsg: Message = {
                id: `tool-start-${event.toolCallId}`,
                role: "tool",
                content: `\u2192 ${event.toolName}(${argsPreview})`,
                timestamp: new Date(),
              };
              const e = tabStatesRef.current.get(tid);
              if (e) {
                e.state.messages = [...e.state.messages, toolStartMsg];
                schedulePersist(tid, e.state.messages);
                if (tid === tabId) forceRender();
              }
            },
            onToolEnd: (event: AgentToolEndEvent) => {
              const e = tabStatesRef.current.get(tid);
              if (!e) return;

              const isRealFailure =
                !event.success ||
                (event.resultPreview?.startsWith("Exit code ") &&
                  !event.resultPreview.startsWith("Exit code 0"));
              const duration =
                event.durationMs > 0
                  ? ` (${(event.durationMs / 1000).toFixed(1)}s)`
                  : "";
              let content: string;
              if (isRealFailure && event.resultPreview) {
                const errMsg = event.resultPreview
                  .slice(0, 120)
                  .split("\n")
                  .slice(0, 2)
                  .join(" ");
                content = `  \u2717 ${errMsg}${duration}`;
              } else {
                content = `  \u2713${duration}`;
              }

              const toolEndMsg: Message = {
                id: `tool-end-${event.toolCallId}`,
                role: "tool",
                content,
                timestamp: new Date(),
                toolSuccess: !isRealFailure,
              };

              e.state.messages = [...e.state.messages, toolEndMsg];
              e.state.toolCount += 1;
              e.state.activeTool = null;
              schedulePersist(tid, e.state.messages);
              if (tid === tabId) forceRender();
            },
            onStepFinish: (event: AgentStepEvent) => {
              const e = tabStatesRef.current.get(tid);
              if (!e) return;

              e.state.stepCount += 1;
              e.state.totalTokens += event.usage.totalTokens;

              // Do not append assistant bubbles per step (stacks N messages; Ink draws over itself).
              // stepNumber 0 = vision/synthetic notices only, as one truncated system line.
              if (event.text && event.text.trim() && event.stepNumber === 0) {
                const t = event.text.trim();
                const content = t.length > 720 ? `${t.slice(0, 717)}...` : t;
                const sysMsg: Message = {
                  id: `system-step0-${Date.now()}`,
                  role: "system",
                  content,
                  timestamp: new Date(),
                };
                e.state.messages = [...e.state.messages, sysMsg];
                schedulePersist(tid, e.state.messages);
              }

              const toolCalls = event.toolCalls ?? [];
              if (toolCalls.length > 0) {
                e.state.status = "executing";
              } else {
                e.state.status = "thinking";
              }

              if (tid === tabId) forceRender();
            },
            onEvidence: (event: AgentEvidenceEvent) => {
              const e = tabStatesRef.current.get(tid);
              if (!e) return;

              const icon = event.verified ? "\u2713" : "\u2717";
              const label = event.type.replace(/_/g, " ");
              let desc = event.description;
              if (event.path) {
                desc = event.path.split("/").pop() || event.path;
              } else if (event.command) {
                desc = event.command.slice(0, 40);
              }

              const evidenceMsg: Message = {
                id: `evidence-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                role: "tool",
                content: `  ${icon} ${label}: ${desc}`,
                timestamp: new Date(),
                toolSuccess: event.verified,
              };
              e.state.messages = [...e.state.messages, evidenceMsg];
              schedulePersist(tid, e.state.messages);
              if (tid === tabId) forceRender();
            },
            onEvidenceSummary: (event: AgentEvidenceSummaryEvent) => {
              const e = tabStatesRef.current.get(tid);
              if (!e || event.total === 0) return;

              const summaryMsg: Message = {
                id: `evidence-summary-${Date.now()}`,
                role: "system",
                content: `[Evidence: ${event.verified}/${event.total} verified]`,
                timestamp: new Date(),
                toolSuccess: event.failed === 0,
              };
              e.state.messages = [...e.state.messages, summaryMsg];
              schedulePersist(tid, e.state.messages);
              if (tid === tabId) forceRender();
            },
          },
        });

        const ready = await newAgent.isReady();
        if (ready) {
          updateTabState(tid, { agent: newAgent, agentReady: true });
          return newAgent;
        } else {
          updateTabState(tid, { agentReady: false });
          return null;
        }
      } catch (err) {
        updateTabState(tid, { agentReady: false });
        return null;
      }
    },
    [model, provider, tabId, getTabEntry, updateTabState, schedulePersist, forceRender]
  );

  // Initialize agent for the current tab on mount / model change
  useEffect(() => {
    getTabEntry(tabId);
    ensureAgent(tabId);
  }, [tabId, model, provider, getTabEntry, ensureAgent]);

  // Return current tab's state
  const entry = getTabEntry(tabId);

  const addMessage = useCallback(
    (msg: Message) => {
      const e = getTabEntry(tabId);
      e.state.messages = [...e.state.messages, msg];
      schedulePersist(tabId, e.state.messages);
      forceRender();
    },
    [tabId, getTabEntry, schedulePersist, forceRender]
  );

  const addSystemMessage = useCallback(
    (content: string) => {
      addMessage({
        id: `system-${Date.now()}`,
        role: "system",
        content,
        timestamp: new Date(),
      });
    },
    [addMessage]
  );

  const chat = useCallback(
    async (
      message: string,
      imageBase64?: string,
      imageMimeType?: string
    ): Promise<void> => {
      const e = getTabEntry(tabId);

      // Queue if already processing
      if (e.agentRunningRef) {
        e.messageQueueRef.push(message);
        addSystemMessage("Queued \u2014 will send after current task completes.");
        return;
      }

      // Add user message
      const userMsg: Message = {
        id: `user-${Date.now()}`,
        role: "user",
        content: message,
        timestamp: new Date(),
      };
      e.state.messages = [...e.state.messages, userMsg];
      schedulePersist(tabId, e.state.messages);

      // Reset progress
      e.agentRunningRef = true;
      updateTabState(tabId, {
        isProcessing: true,
        status: "thinking",
        activeTool: null,
        stepCount: 0,
        toolCount: 0,
        totalTokens: 0,
      });
      forceRender();

      const agent = await ensureAgent(tabId);

      if (agent) {
        try {
          const reply = await agent.chat(message, imageBase64, imageMimeType);
          const trimmed = (reply ?? "").trim();
          if (trimmed) {
            const assistantMsg: Message = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: trimmed,
              timestamp: new Date(),
            };
            e.state.messages = [...e.state.messages, assistantMsg];
            schedulePersist(tabId, e.state.messages);
          }
          updateTabState(tabId, { status: "success" });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const errMessage: Message = {
            id: `assistant-error-${Date.now()}`,
            role: "assistant",
            content: `[Error] ${errorMsg}`,
            timestamp: new Date(),
          };
          e.state.messages = [...e.state.messages, errMessage];
          schedulePersist(tabId, e.state.messages);
          updateTabState(tabId, { status: "error" });
        }
      } else {
        // Agent not ready — show error
        const notReadyMsg: Message = {
          id: `system-${Date.now()}`,
          role: "system",
          content: "Agent not ready. Check your provider connection.",
          timestamp: new Date(),
        };
        e.state.messages = [...e.state.messages, notReadyMsg];
        schedulePersist(tabId, e.state.messages);
        updateTabState(tabId, { status: "error" });
      }

      // Done processing
      e.agentRunningRef = false;
      updateTabState(tabId, { isProcessing: false });
      forceRender();

      // Process queued messages
      if (e.messageQueueRef.length > 0) {
        const next = e.messageQueueRef.shift()!;
        // Fire-and-forget the next queued message
        chat(next);
      }
    },
    [tabId, getTabEntry, addSystemMessage, schedulePersist, updateTabState, forceRender, ensureAgent]
  );

  const abort = useCallback(() => {
    const e = getTabEntry(tabId);
    if (e.state.agent && e.state.isProcessing) {
      e.state.agent.abort();
      e.agentRunningRef = false;
      updateTabState(tabId, {
        isProcessing: false,
        activeTool: null,
        status: "idle",
      });
      addSystemMessage("Generation interrupted.");
    }
  }, [tabId, getTabEntry, updateTabState, addSystemMessage]);

  const cleanup = useCallback(() => {
    const e = tabStatesRef.current.get(tabId);
    if (e) {
      // Abort any running agent
      if (e.state.agent && e.state.isProcessing) {
        e.state.agent.abort();
      }
      // Persist final messages
      persistMessages(tabId, e.state.messages);
      // Remove from map
      tabStatesRef.current.delete(tabId);
      // Clear save timer
      const timer = saveTimersRef.current.get(tabId);
      if (timer) {
        clearTimeout(timer);
        saveTimersRef.current.delete(tabId);
      }
    }
  }, [tabId]);

  return {
    state: entry.state,
    addMessage,
    addSystemMessage,
    chat,
    abort,
    cleanup,
  };
}
