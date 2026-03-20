/**
 * Session Logger — writes structured session events to ~/.8gent/sessions/ as JSONL.
 *
 * Each line is one JSON object with { type, timestamp, sequenceNumber, ... }.
 * The debugger webapp reads these .jsonl files via SSE streaming.
 *
 * Event types match the debugger schema:
 *   session_start, user_message, assistant_message, tool_call, tool_result,
 *   step_finish, error, tab_switch, session_end
 */

import * as fs from "fs";
import * as path from "path";

// ============================================
// Types
// ============================================

export interface SessionEvent {
  type: string;
  timestamp: string;
  sequenceNumber: number;
  [key: string]: unknown;
}

export interface SessionLog {
  id: string;
  name: string;
  startedAt: string;
  lastUpdatedAt: string;
  model: string;
  provider: string;
  tabId: string;
  tabName: string;
  events: SessionEvent[];
  stats: {
    messageCount: number;
    toolCalls: number;
    totalTokens: number;
    errors: number;
    durationMs: number;
  };
}

// ============================================
// State
// ============================================

let sessionId: string | null = null;
let sessionFilePath: string | null = null;
let sessionStartedAt: string | null = null;
let sessionModel: string | null = null;
let sessionProvider: string | null = null;
let sessionName: string | null = null;
let sequenceNumber = 0;

// In-memory event buffer for getSessionLog / getSessionSummary
let events: SessionEvent[] = [];

// Stats counters (incremental — no need to recompute)
let statMessages = 0;
let statToolCalls = 0;
let statTotalTokens = 0;
let statErrors = 0;
let stepCount = 0;

// Pending writes buffer (batched via flush timer)
let pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const SESSIONS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".8gent",
  "sessions"
);

const FLUSH_INTERVAL_MS = 500;

// ============================================
// Internal helpers
// ============================================

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function getGitBranch(): string | null {
  try {
    const headPath = path.join(process.cwd(), ".git", "HEAD");
    if (fs.existsSync(headPath)) {
      const head = fs.readFileSync(headPath, "utf-8").trim();
      if (head.startsWith("ref: refs/heads/")) {
        return head.slice("ref: refs/heads/".length);
      }
      return head.slice(0, 8); // detached HEAD
    }
  } catch {
    // ignore
  }
  return null;
}

function appendLine(event: SessionEvent): void {
  events.push(event);
  pendingLines.push(JSON.stringify(event));
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writePending();
  }, FLUSH_INTERVAL_MS);
}

function writePending(): void {
  if (!sessionFilePath || pendingLines.length === 0) return;
  const chunk = pendingLines.join("\n") + "\n";
  pendingLines = [];
  try {
    fs.appendFileSync(sessionFilePath, chunk, "utf-8");
  } catch {
    // Silently ignore write failures — don't crash the TUI
  }
}

function nextSeq(): number {
  return sequenceNumber++;
}

function now(): string {
  return new Date().toISOString();
}

function getDurationMs(): number {
  if (!sessionStartedAt) return 0;
  return Date.now() - new Date(sessionStartedAt).getTime();
}

// ============================================
// Public API
// ============================================

export function initSessionLogger(
  id: string,
  model: string,
  provider: string
): void {
  ensureSessionsDir();

  const ts = new Date();
  const tsStr = ts.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const random = Math.random().toString(36).slice(2, 8);
  const filename = `session_${tsStr}_${random}.jsonl`;
  sessionFilePath = path.join(SESSIONS_DIR, filename);

  sessionId = id;
  sessionStartedAt = ts.toISOString();
  sessionModel = model;
  sessionProvider = provider;
  sessionName = id;
  sequenceNumber = 0;
  events = [];
  pendingLines = [];
  statMessages = 0;
  statToolCalls = 0;
  statTotalTokens = 0;
  statErrors = 0;
  stepCount = 0;

  // Write the session_start event immediately (not batched)
  const startEvent: SessionEvent = {
    type: "session_start",
    timestamp: sessionStartedAt,
    sequenceNumber: nextSeq(),
    meta: {
      sessionId: id,
      version: 2,
      startedAt: sessionStartedAt,
      agent: {
        model,
        runtime: `bun@${typeof Bun !== "undefined" ? Bun.version : "unknown"}`,
      },
      environment: {
        workingDirectory: process.cwd(),
        gitBranch: getGitBranch(),
      },
    },
  };

  events.push(startEvent);
  try {
    fs.writeFileSync(sessionFilePath, JSON.stringify(startEvent) + "\n", "utf-8");
  } catch {
    // ignore
  }
}

export function logMessage(
  tabId: string,
  tabName: string,
  role: string,
  content: string
): void {
  if (!sessionId) return;

  // Set session name from first user message
  if (role === "user" && sessionName === sessionId) {
    sessionName = content.slice(0, 50).trim() || sessionId;
  }

  statMessages++;

  const type = role === "user" ? "user_message" : "assistant_message";
  appendLine({
    type,
    timestamp: now(),
    sequenceNumber: nextSeq(),
    message: {
      role,
      content: content.slice(0, 2000),
    },
    tabId,
    tabName,
  });
}

export function logToolStart(
  tabId: string,
  tabName: string,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>
): void {
  if (!sessionId) return;

  appendLine({
    type: "tool_call",
    timestamp: now(),
    sequenceNumber: nextSeq(),
    toolCall: {
      toolCallId,
      name: toolName,
      arguments: JSON.parse(JSON.stringify(args || {}).slice(0, 2000)),
    },
    tabId,
    tabName,
  });
}

export function logToolEnd(
  toolCallId: string,
  success: boolean,
  durationMs: number,
  resultPreview?: string
): void {
  if (!sessionId) return;

  statToolCalls++;

  // Find the matching tool_call to get tabId/tabName
  let tabId = "default";
  let tabName = "Chat";
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === "tool_call" &&
      (e.toolCall as { toolCallId: string })?.toolCallId === toolCallId
    ) {
      tabId = (e.tabId as string) || "default";
      tabName = (e.tabName as string) || "Chat";
      break;
    }
  }

  appendLine({
    type: "tool_result",
    timestamp: now(),
    sequenceNumber: nextSeq(),
    toolCallId,
    result: resultPreview?.slice(0, 500) ?? null,
    success,
    durationMs,
    tabId,
    tabName,
  });
}

export function logStep(
  tabId: string,
  tabName: string,
  stepNumber: number,
  totalTokens: number,
  text?: string
): void {
  if (!sessionId) return;

  statTotalTokens += totalTokens;
  stepCount = Math.max(stepCount, stepNumber);

  appendLine({
    type: "step_finish",
    timestamp: now(),
    sequenceNumber: nextSeq(),
    stepNumber,
    finishReason: "stop",
    totalTokens,
    text: text?.slice(0, 500),
    tabId,
    tabName,
  });
}

export function logError(
  tabId: string,
  tabName: string,
  error: string
): void {
  if (!sessionId) return;

  statErrors++;

  appendLine({
    type: "error",
    timestamp: now(),
    sequenceNumber: nextSeq(),
    error: {
      message: error.slice(0, 2000),
    },
    tabId,
    tabName,
  });
}

export function logTabSwitch(
  fromTabId: string,
  toTabId: string,
  toTabName: string
): void {
  if (!sessionId) return;

  appendLine({
    type: "tab_switch",
    timestamp: now(),
    sequenceNumber: nextSeq(),
    fromTabId,
    toTabId,
    toTabName,
    tabId: toTabId,
    tabName: toTabName,
  });
}

export function getSessionLog(): SessionLog {
  if (!sessionId) {
    throw new Error("Session logger not initialized");
  }
  return {
    id: sessionId,
    name: sessionName || sessionId,
    startedAt: sessionStartedAt || new Date().toISOString(),
    lastUpdatedAt: now(),
    model: sessionModel || "",
    provider: sessionProvider || "",
    tabId: "default",
    tabName: "Chat",
    events,
    stats: {
      messageCount: statMessages,
      toolCalls: statToolCalls,
      totalTokens: statTotalTokens,
      errors: statErrors,
      durationMs: getDurationMs(),
    },
  };
}

export function getSessionPath(): string {
  if (!sessionFilePath) {
    throw new Error("Session logger not initialized");
  }
  return sessionFilePath;
}

export function getSessionSummary(): string {
  if (!sessionId) return "No active session";
  const dur = (getDurationMs() / 1000 / 60).toFixed(1);
  return [
    `Session: ${sessionName}`,
    `Model: ${sessionModel} (${sessionProvider})`,
    `Duration: ${dur}m`,
    `Messages: ${statMessages}`,
    `Tool calls: ${statToolCalls}`,
    `Tokens: ${statTotalTokens.toLocaleString()}`,
    `Errors: ${statErrors}`,
  ].join(" | ");
}

export function flushSession(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // Write session_end event
  if (sessionId) {
    const endEvent: SessionEvent = {
      type: "session_end",
      timestamp: now(),
      sequenceNumber: nextSeq(),
      summary: {
        exitReason: "user_exit",
        durationMs: getDurationMs(),
        totalSteps: stepCount,
        messageCount: statMessages,
        toolCalls: statToolCalls,
        totalTokens: statTotalTokens,
        errors: statErrors,
      },
    };
    events.push(endEvent);
    pendingLines.push(JSON.stringify(endEvent));
  }

  writePending();
}
