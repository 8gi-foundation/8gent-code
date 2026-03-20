/**
 * Session Logger — writes structured session events to ~/.8gent/sessions/ in real-time.
 *
 * Used by the TUI to capture every message, tool call, error, and tab switch
 * so that the debug CLI can inspect, tail, and analyze sessions.
 */

import * as fs from "fs";
import * as path from "path";

// ============================================
// Types
// ============================================

export interface SessionEvent {
  type: "message" | "tool_start" | "tool_end" | "step" | "error" | "tab_switch" | "system";
  timestamp: string;
  tabId: string;
  tabName: string;
  data: Record<string, unknown>;
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

let session: SessionLog | null = null;
let sessionFilePath: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

const SESSIONS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".8gent",
  "sessions"
);

const FLUSH_INTERVAL_MS = 1000;

// ============================================
// Internal helpers
// ============================================

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function recomputeStats(): void {
  if (!session) return;
  const events = session.events;
  let messageCount = 0;
  let toolCalls = 0;
  let totalTokens = 0;
  let errors = 0;

  for (const e of events) {
    if (e.type === "message") messageCount++;
    if (e.type === "tool_end") toolCalls++;
    if (e.type === "error") errors++;
    if (e.type === "step" && typeof e.data.totalTokens === "number") {
      totalTokens += e.data.totalTokens as number;
    }
  }

  const startMs = new Date(session.startedAt).getTime();
  const durationMs = Date.now() - startMs;

  session.stats = { messageCount, toolCalls, totalTokens, errors, durationMs };
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return; // already scheduled
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeToDisk();
  }, FLUSH_INTERVAL_MS);
}

function writeToDisk(): void {
  if (!session || !sessionFilePath || !dirty) return;
  dirty = false;
  session.lastUpdatedAt = new Date().toISOString();
  recomputeStats();
  try {
    fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2), "utf-8");
  } catch {
    // Silently ignore write failures — don't crash the TUI
  }
}

function pushEvent(event: SessionEvent): void {
  if (!session) return;
  session.events.push(event);
  scheduleFlush();
}

// ============================================
// Public API
// ============================================

export function initSessionLogger(
  sessionId: string,
  model: string,
  provider: string
): void {
  ensureSessionsDir();

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${ts}-${sanitizeFilename(sessionId)}.json`;
  sessionFilePath = path.join(SESSIONS_DIR, filename);

  session = {
    id: sessionId,
    name: sessionId,
    startedAt: now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    model,
    provider,
    tabId: "default",
    tabName: "Chat",
    events: [],
    stats: {
      messageCount: 0,
      toolCalls: 0,
      totalTokens: 0,
      errors: 0,
      durationMs: 0,
    },
  };

  // Write the initial file immediately
  dirty = true;
  writeToDisk();
}

export function logMessage(
  tabId: string,
  tabName: string,
  role: string,
  content: string
): void {
  if (!session) return;

  // Set session name from first user message
  if (role === "user" && session.name === session.id) {
    session.name = content.slice(0, 50).trim() || session.id;
  }

  pushEvent({
    type: "message",
    timestamp: new Date().toISOString(),
    tabId,
    tabName,
    data: { role, content: content.slice(0, 2000) },
  });
}

export function logToolStart(
  tabId: string,
  tabName: string,
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>
): void {
  pushEvent({
    type: "tool_start",
    timestamp: new Date().toISOString(),
    tabId,
    tabName,
    data: {
      toolName,
      toolCallId,
      args: JSON.parse(JSON.stringify(args || {}).slice(0, 2000)),
    },
  });
}

export function logToolEnd(
  toolCallId: string,
  success: boolean,
  durationMs: number,
  resultPreview?: string
): void {
  if (!session) return;

  // Find the matching tool_start to get tabId/tabName
  let tabId = "default";
  let tabName = "Chat";
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i];
    if (e.type === "tool_start" && e.data.toolCallId === toolCallId) {
      tabId = e.tabId;
      tabName = e.tabName;
      break;
    }
  }

  pushEvent({
    type: "tool_end",
    timestamp: new Date().toISOString(),
    tabId,
    tabName,
    data: {
      toolCallId,
      success,
      durationMs,
      resultPreview: resultPreview?.slice(0, 500),
    },
  });
}

export function logStep(
  tabId: string,
  tabName: string,
  stepNumber: number,
  totalTokens: number,
  text?: string
): void {
  pushEvent({
    type: "step",
    timestamp: new Date().toISOString(),
    tabId,
    tabName,
    data: { stepNumber, totalTokens, text: text?.slice(0, 500) },
  });
}

export function logError(
  tabId: string,
  tabName: string,
  error: string
): void {
  pushEvent({
    type: "error",
    timestamp: new Date().toISOString(),
    tabId,
    tabName,
    data: { error: error.slice(0, 2000) },
  });
}

export function logTabSwitch(
  fromTabId: string,
  toTabId: string,
  toTabName: string
): void {
  pushEvent({
    type: "tab_switch",
    timestamp: new Date().toISOString(),
    tabId: toTabId,
    tabName: toTabName,
    data: { fromTabId, toTabId, toTabName },
  });
}

export function getSessionLog(): SessionLog {
  if (!session) {
    throw new Error("Session logger not initialized");
  }
  recomputeStats();
  return { ...session };
}

export function getSessionPath(): string {
  if (!sessionFilePath) {
    throw new Error("Session logger not initialized");
  }
  return sessionFilePath;
}

export function getSessionSummary(): string {
  if (!session) return "No active session";
  recomputeStats();
  const s = session.stats;
  const dur = (s.durationMs / 1000 / 60).toFixed(1);
  return [
    `Session: ${session.name}`,
    `Model: ${session.model} (${session.provider})`,
    `Duration: ${dur}m`,
    `Messages: ${s.messageCount}`,
    `Tool calls: ${s.toolCalls}`,
    `Tokens: ${s.totalTokens.toLocaleString()}`,
    `Errors: ${s.errors}`,
  ].join(" | ");
}

export function flushSession(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (session) {
    dirty = true;
    writeToDisk();
  }
}
