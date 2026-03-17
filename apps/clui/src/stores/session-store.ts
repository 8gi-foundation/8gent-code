/**
 * 8gent CLUI -- Session Store (Zustand)
 *
 * Manages multi-tab session state. Each session represents an independent
 * 8gent agent subprocess with its own message history, status, and metadata.
 *
 * Adapted from the TUI's in-memory state management but designed for
 * concurrent sessions with persistence.
 */

import { create } from "zustand";

// ── Types ────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: Date;
  /** For tool messages */
  toolName?: string;
  toolSuccess?: boolean;
  /** For streaming -- true while tokens are still arriving */
  isStreaming?: boolean;
}

export type SessionStatus = "idle" | "processing" | "error" | "disconnected";

export type ProcessingStage = "planning" | "toolshed" | "executing" | "complete";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "running" | "complete" | "failed";
  output?: string;
  startedAt: Date;
  completedAt?: Date;
}

export interface SessionState {
  id: string;
  label: string;
  messages: Message[];
  status: SessionStatus;
  processingStage: ProcessingStage;
  model: string;
  activeTool: string | null;
  stepCount: number;
  toolCount: number;
  totalTokens: number;
  toolCalls: ToolCall[];
  createdAt: Date;
  lastActiveAt: Date;
  cwd: string;
  /** Git branch if in a repo */
  gitBranch: string | null;
}

export interface SessionStore {
  sessions: Record<string, SessionState>;
  activeSessionId: string | null;
  maxSessions: number;

  // Actions
  createSession: (opts?: { label?: string; model?: string; cwd?: string }) => string;
  closeSession: (id: string) => void;
  switchTab: (id: string) => void;
  sendMessage: (sessionId: string, content: string) => void;
  appendMessage: (sessionId: string, message: Message) => void;
  updateStreamingMessage: (sessionId: string, messageId: string, content: string) => void;
  finalizeStreamingMessage: (sessionId: string, messageId: string) => void;
  setSessionStatus: (sessionId: string, status: SessionStatus) => void;
  setProcessingStage: (sessionId: string, stage: ProcessingStage) => void;
  setActiveTool: (sessionId: string, tool: string | null) => void;
  incrementStepCount: (sessionId: string) => void;
  incrementToolCount: (sessionId: string) => void;
  addTokens: (sessionId: string, tokens: number) => void;
  addToolCall: (sessionId: string, toolCall: ToolCall) => void;
  updateToolCall: (sessionId: string, toolCallId: string, update: Partial<ToolCall>) => void;
  setGitBranch: (sessionId: string, branch: string | null) => void;
  setLabel: (sessionId: string, label: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

let idCounter = 0;

function generateId(): string {
  idCounter += 1;
  return `session_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function generateMessageId(): string {
  idCounter += 1;
  return `msg_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function createDefaultSession(opts?: {
  label?: string;
  model?: string;
  cwd?: string;
}): SessionState {
  const id = generateId();
  return {
    id,
    label: opts?.label || "New Session",
    messages: [],
    status: "idle",
    processingStage: "planning",
    model: opts?.model || "qwen3.5",
    activeTool: null,
    stepCount: 0,
    toolCount: 0,
    totalTokens: 0,
    toolCalls: [],
    createdAt: new Date(),
    lastActiveAt: new Date(),
    cwd: opts?.cwd || process.cwd?.() || "~",
    gitBranch: null,
  };
}

// ── Store ────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: {},
  activeSessionId: null,
  maxSessions: 10,

  createSession: (opts) => {
    const state = get();
    if (Object.keys(state.sessions).length >= state.maxSessions) {
      console.warn(`Maximum sessions (${state.maxSessions}) reached`);
      return state.activeSessionId || "";
    }

    const session = createDefaultSession(opts);
    set((s) => ({
      sessions: { ...s.sessions, [session.id]: session },
      activeSessionId: session.id,
    }));
    return session.id;
  },

  closeSession: (id) => {
    set((s) => {
      const { [id]: removed, ...remaining } = s.sessions;
      const sessionIds = Object.keys(remaining);

      // If closing the active tab, switch to the nearest tab
      let newActiveId = s.activeSessionId;
      if (s.activeSessionId === id) {
        newActiveId = sessionIds.length > 0 ? sessionIds[sessionIds.length - 1] : null;
      }

      return {
        sessions: remaining,
        activeSessionId: newActiveId,
      };
    });
  },

  switchTab: (id) => {
    set({ activeSessionId: id });
  },

  sendMessage: (sessionId, content) => {
    const message: Message = {
      id: generateMessageId(),
      role: "user",
      content,
      timestamp: new Date(),
    };

    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            messages: [...session.messages, message],
            status: "processing" as SessionStatus,
            lastActiveAt: new Date(),
            stepCount: 0,
            toolCount: 0,
            activeTool: null,
          },
        },
      };
    });

    // In production, this is where we'd send to the Tauri backend
    // via invoke("send_to_agent", { sessionId, content })
    // For now, simulate a response
    setTimeout(() => {
      const assistantMsg: Message = {
        id: generateMessageId(),
        role: "assistant",
        content: `Received: "${content}"\n\nThis is a placeholder response. In production, this would come from the 8gent engine subprocess via NDJSON event streaming.`,
        timestamp: new Date(),
      };
      get().appendMessage(sessionId, assistantMsg);
      get().setSessionStatus(sessionId, "idle");
    }, 1500);
  },

  appendMessage: (sessionId, message) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            messages: [...session.messages, message],
            lastActiveAt: new Date(),
          },
        },
      };
    });
  },

  updateStreamingMessage: (sessionId, messageId, content) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      const messages = session.messages.map((m) =>
        m.id === messageId ? { ...m, content, isStreaming: true } : m,
      );

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, messages },
        },
      };
    });
  },

  finalizeStreamingMessage: (sessionId, messageId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      const messages = session.messages.map((m) =>
        m.id === messageId ? { ...m, isStreaming: false } : m,
      );

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, messages },
        },
      };
    });
  },

  setSessionStatus: (sessionId, status) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, status },
        },
      };
    });
  },

  setProcessingStage: (sessionId, stage) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, processingStage: stage },
        },
      };
    });
  },

  setActiveTool: (sessionId, tool) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, activeTool: tool },
        },
      };
    });
  },

  incrementStepCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, stepCount: session.stepCount + 1 },
        },
      };
    });
  },

  incrementToolCount: (sessionId) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, toolCount: session.toolCount + 1 },
        },
      };
    });
  },

  addTokens: (sessionId, tokens) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, totalTokens: session.totalTokens + tokens },
        },
      };
    });
  },

  addToolCall: (sessionId, toolCall) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...session,
            toolCalls: [...session.toolCalls, toolCall],
          },
        },
      };
    });
  },

  updateToolCall: (sessionId, toolCallId, update) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      const toolCalls = session.toolCalls.map((tc) =>
        tc.id === toolCallId ? { ...tc, ...update } : tc,
      );

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, toolCalls },
        },
      };
    });
  },

  setGitBranch: (sessionId, branch) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, gitBranch: branch },
        },
      };
    });
  },

  setLabel: (sessionId, label) => {
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...session, label },
        },
      };
    });
  },
}));
