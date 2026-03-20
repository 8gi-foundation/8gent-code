#!/usr/bin/env bun
/**
 * 8gent Debug CLI — inspect, tail, and analyze TUI sessions.
 *
 * Supports both legacy .json format and new .jsonl format.
 *
 * Usage:
 *   bun run bin/debug.ts sessions              # List recent sessions
 *   bun run bin/debug.ts inspect <id>          # Show session detail
 *   bun run bin/debug.ts export <id>           # Export session as JSON to stdout
 *   bun run bin/debug.ts tail                  # Live tail of most recent session
 *   bun run bin/debug.ts health                # System health check
 *   bun run bin/debug.ts tools <id>            # Show tool call timeline
 *   bun run bin/debug.ts errors [id]           # Show errors
 */

import * as fs from "fs";
import * as path from "path";

// ============================================
// ANSI color helpers
// ============================================

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  boldRed: "\x1b[1;31m",
  boldGreen: "\x1b[1;32m",
  boldCyan: "\x1b[1;36m",
  boldMagenta: "\x1b[1;35m",
  boldYellow: "\x1b[1;33m",
  boldBlue: "\x1b[1;34m",
};

// ============================================
// Constants
// ============================================

const SESSIONS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".8gent",
  "sessions"
);

const DOT_8GENT = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".8gent"
);

// ============================================
// Unified session representation
// ============================================

interface NormalizedEvent {
  type: string;
  timestamp: string;
  tabId: string;
  tabName: string;
  data: Record<string, unknown>;
}

interface NormalizedSession {
  id: string;
  name: string;
  startedAt: string;
  lastUpdatedAt: string;
  model: string;
  provider: string;
  events: NormalizedEvent[];
  stats: {
    messageCount: number;
    toolCalls: number;
    totalTokens: number;
    errors: number;
    durationMs: number;
  };
  format: "json" | "jsonl";
}

// ============================================
// Helpers
// ============================================

function listSessionFiles(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json") || f.endsWith(".jsonl"))
    .sort()
    .reverse();
}

/**
 * Parse a .jsonl file into a NormalizedSession.
 */
function parseJsonlSession(filePath: string, fileId: string): NormalizedSession {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  let id = fileId;
  let name = fileId;
  let startedAt = "";
  let model = "";
  let provider = "";
  let lastTimestamp = "";
  let messageCount = 0;
  let toolCalls = 0;
  let totalTokens = 0;
  let errors = 0;
  let durationMs = 0;

  const events: NormalizedEvent[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = (entry.timestamp as string) || "";
    const tabId = (entry.tabId as string) || "default";
    const tabName = (entry.tabName as string) || "Chat";
    if (ts) lastTimestamp = ts;

    switch (entry.type) {
      case "session_start": {
        const meta = entry.meta as Record<string, unknown> | undefined;
        if (meta) {
          id = (meta.sessionId as string) || id;
          startedAt = (meta.startedAt as string) || ts;
          const agent = meta.agent as Record<string, unknown> | undefined;
          model = (agent?.model as string) || "";
          provider = (agent?.runtime as string) || "";
        }
        break;
      }
      case "user_message": {
        messageCount++;
        const msg = entry.message as Record<string, unknown> | undefined;
        const content = (msg?.content as string) || "";
        if (name === fileId && content) {
          name = content.slice(0, 50).trim();
        }
        events.push({
          type: "message",
          timestamp: ts,
          tabId,
          tabName,
          data: { role: "user", content },
        });
        break;
      }
      case "assistant_message": {
        messageCount++;
        const msg = entry.message as Record<string, unknown> | undefined;
        events.push({
          type: "message",
          timestamp: ts,
          tabId,
          tabName,
          data: { role: "assistant", content: (msg?.content as string) || "" },
        });
        break;
      }
      case "tool_call": {
        const tc = entry.toolCall as Record<string, unknown> | undefined;
        events.push({
          type: "tool_start",
          timestamp: ts,
          tabId,
          tabName,
          data: {
            toolName: (tc?.name as string) || "",
            toolCallId: (tc?.toolCallId as string) || "",
            args: tc?.arguments || {},
          },
        });
        break;
      }
      case "tool_result": {
        toolCalls++;
        events.push({
          type: "tool_end",
          timestamp: ts,
          tabId,
          tabName,
          data: {
            toolCallId: (entry.toolCallId as string) || "",
            success: entry.success as boolean,
            durationMs: (entry.durationMs as number) || 0,
            resultPreview: (entry.result as string) || "",
          },
        });
        break;
      }
      case "step_finish": {
        const tokens = (entry.totalTokens as number) || 0;
        totalTokens += tokens;
        events.push({
          type: "step",
          timestamp: ts,
          tabId,
          tabName,
          data: {
            stepNumber: entry.stepNumber,
            totalTokens: tokens,
            text: entry.text || "",
          },
        });
        break;
      }
      case "error": {
        errors++;
        const err = entry.error as Record<string, unknown> | undefined;
        events.push({
          type: "error",
          timestamp: ts,
          tabId,
          tabName,
          data: { error: (err?.message as string) || "" },
        });
        break;
      }
      case "tab_switch": {
        events.push({
          type: "tab_switch",
          timestamp: ts,
          tabId,
          tabName,
          data: {
            fromTabId: entry.fromTabId,
            toTabId: entry.toTabId,
            toTabName: entry.toTabName,
          },
        });
        break;
      }
      case "session_end": {
        const summary = entry.summary as Record<string, unknown> | undefined;
        if (summary) {
          durationMs = (summary.durationMs as number) || 0;
        }
        break;
      }
      default: {
        events.push({
          type: (entry.type as string) || "unknown",
          timestamp: ts,
          tabId,
          tabName,
          data: entry,
        });
      }
    }
  }

  if (!durationMs && startedAt) {
    durationMs =
      new Date(lastTimestamp || Date.now()).getTime() -
      new Date(startedAt).getTime();
  }

  return {
    id,
    name,
    startedAt: startedAt || lastTimestamp,
    lastUpdatedAt: lastTimestamp,
    model,
    provider,
    events,
    stats: { messageCount, toolCalls, totalTokens, errors, durationMs },
    format: "jsonl",
  };
}

/**
 * Parse a legacy .json file into a NormalizedSession.
 */
function parseLegacyJsonSession(
  filePath: string,
  fileId: string
): NormalizedSession {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return {
    id: raw.id || fileId,
    name: raw.name || fileId,
    startedAt: raw.startedAt || "",
    lastUpdatedAt: raw.lastUpdatedAt || "",
    model: raw.model || "",
    provider: raw.provider || "",
    events: (raw.events || []).map(
      (e: Record<string, unknown>) =>
        ({
          type: (e.type as string) || "unknown",
          timestamp: (e.timestamp as string) || "",
          tabId: (e.tabId as string) || "default",
          tabName: (e.tabName as string) || "Chat",
          data: (e.data as Record<string, unknown>) || {},
        }) satisfies NormalizedEvent
    ),
    stats: raw.stats || {
      messageCount: 0,
      toolCalls: 0,
      totalTokens: 0,
      errors: 0,
      durationMs: 0,
    },
    format: "json",
  };
}

function loadSession(fileOrId: string): NormalizedSession | null {
  // Try exact filename first (both extensions)
  for (const ext of [".jsonl", ".json"]) {
    let filePath = path.join(SESSIONS_DIR, fileOrId);
    if (!filePath.endsWith(ext) && !filePath.endsWith(".json") && !filePath.endsWith(".jsonl")) {
      filePath += ext;
    } else if (!filePath.endsWith(ext)) {
      continue;
    }
    if (fs.existsSync(filePath)) {
      const id = path.basename(filePath).replace(/\.(jsonl|json)$/, "");
      return filePath.endsWith(".jsonl")
        ? parseJsonlSession(filePath, id)
        : parseLegacyJsonSession(filePath, id);
    }
  }

  // Try with explicit extension appended
  for (const ext of [".jsonl", ".json"]) {
    const filePath = path.join(SESSIONS_DIR, fileOrId + ext);
    if (fs.existsSync(filePath)) {
      const id = fileOrId;
      return ext === ".jsonl"
        ? parseJsonlSession(filePath, id)
        : parseLegacyJsonSession(filePath, id);
    }
  }

  // Try partial match on session ID or filename
  const files = listSessionFiles();
  const match = files.find(
    (f) => f.includes(fileOrId) || f.startsWith(fileOrId)
  );
  if (match) {
    const filePath = path.join(SESSIONS_DIR, match);
    const id = match.replace(/\.(jsonl|json)$/, "");
    return match.endsWith(".jsonl")
      ? parseJsonlSession(filePath, id)
      : parseLegacyJsonSession(filePath, id);
  }

  return null;
}

function loadSessionQuick(
  filePath: string
): { name: string; model: string; stats: NormalizedSession["stats"] } | null {
  try {
    const id = path
      .basename(filePath)
      .replace(/\.(jsonl|json)$/, "");
    if (filePath.endsWith(".jsonl")) {
      const s = parseJsonlSession(filePath, id);
      return { name: s.name, model: s.model, stats: s.stats };
    } else {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return {
        name: raw.name || id,
        model: raw.model || "?",
        stats: raw.stats || {
          messageCount: 0,
          toolCalls: 0,
          totalTokens: 0,
          errors: 0,
          durationMs: 0,
        },
      };
    }
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

function shortTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString();
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len - 3) + "...";
}

// ============================================
// Commands
// ============================================

function cmdSessions(): void {
  const files = listSessionFiles();
  if (files.length === 0) {
    console.log(`${c.yellow}No sessions found in ${SESSIONS_DIR}${c.reset}`);
    console.log(
      `${c.dim}Sessions are created when you run the TUI.${c.reset}`
    );
    return;
  }

  console.log(
    `${c.boldCyan}Recent Sessions${c.reset} ${c.dim}(${files.length} total)${c.reset}\n`
  );
  console.log(
    `${c.dim}${"ID".padEnd(30)} ${"Name".padEnd(35)} ${"Model".padEnd(20)} ${"Msgs".padEnd(6)} ${"Tools".padEnd(7)} ${"Errors".padEnd(7)} Duration${c.reset}`
  );
  console.log(c.dim + "-".repeat(120) + c.reset);

  const toShow = files.slice(0, 20);
  for (const file of toShow) {
    try {
      const filePath = path.join(SESSIONS_DIR, file);
      const session = loadSessionQuick(filePath);
      if (!session) {
        console.log(`${c.red}${file} — corrupt${c.reset}`);
        continue;
      }
      const id = file.replace(/\.(jsonl|json)$/, "");
      const name = truncate(session.name || "untitled", 33);
      const model = truncate(session.model || "?", 18);
      const msgs = String(session.stats?.messageCount ?? 0).padEnd(6);
      const tools = String(session.stats?.toolCalls ?? 0).padEnd(7);
      const errs = session.stats?.errors
        ? `${c.red}${String(session.stats.errors).padEnd(7)}${c.reset}`
        : String(0).padEnd(7);
      const dur = formatDuration(session.stats?.durationMs ?? 0);

      console.log(
        `${c.cyan}${truncate(id, 28).padEnd(30)}${c.reset} ${name.padEnd(35)} ${c.dim}${model.padEnd(20)}${c.reset} ${msgs} ${tools} ${errs} ${dur}`
      );
    } catch {
      console.log(`${c.red}${file} — corrupt${c.reset}`);
    }
  }

  if (files.length > 20) {
    console.log(
      `\n${c.dim}...and ${files.length - 20} more. Use 'inspect <id>' to view details.${c.reset}`
    );
  }
}

function cmdInspect(id: string): void {
  const session = loadSession(id);
  if (!session) {
    console.log(`${c.red}Session not found: ${id}${c.reset}`);
    return;
  }

  console.log(`${c.boldCyan}Session: ${session.name}${c.reset}`);
  console.log(`${c.dim}ID: ${session.id}${c.reset}`);
  console.log(
    `${c.dim}Started: ${formatTimestamp(session.startedAt)}${c.reset}`
  );
  console.log(
    `${c.dim}Model: ${session.model} (${session.provider})${c.reset}`
  );
  console.log(
    `${c.dim}Duration: ${formatDuration(session.stats?.durationMs ?? 0)}${c.reset}`
  );
  console.log(
    `${c.dim}Messages: ${session.stats?.messageCount ?? 0} | Tools: ${session.stats?.toolCalls ?? 0} | Tokens: ${(session.stats?.totalTokens ?? 0).toLocaleString()} | Errors: ${session.stats?.errors ?? 0}${c.reset}`
  );
  console.log(
    `${c.dim}Format: ${session.format}${c.reset}`
  );
  console.log();

  for (const event of session.events) {
    const ts = shortTimestamp(event.timestamp);
    const tab =
      event.tabName !== "Chat" ? ` ${c.blue}[${event.tabName}]${c.reset}` : "";

    switch (event.type) {
      case "message": {
        const role = event.data.role as string;
        const content = truncate(
          String(event.data.content || "").replace(/\n/g, " "),
          100
        );
        if (role === "user") {
          console.log(
            `${c.dim}${ts}${c.reset}${tab} ${c.boldCyan}user:${c.reset} ${c.cyan}${content}${c.reset}`
          );
        } else if (role === "assistant") {
          console.log(
            `${c.dim}${ts}${c.reset}${tab} ${c.boldGreen}assistant:${c.reset} ${c.green}${content}${c.reset}`
          );
        } else {
          console.log(
            `${c.dim}${ts}${c.reset}${tab} ${c.yellow}${role}:${c.reset} ${content}`
          );
        }
        break;
      }
      case "tool_start": {
        const name = event.data.toolName as string;
        const args = truncate(JSON.stringify(event.data.args || {}), 60);
        console.log(
          `${c.dim}${ts}${c.reset}${tab} ${c.magenta}tool:${c.reset} ${c.boldMagenta}${name}${c.reset}${c.dim}(${args})${c.reset}`
        );
        break;
      }
      case "tool_end": {
        const ok = event.data.success as boolean;
        const dur = formatDuration((event.data.durationMs as number) || 0);
        const icon = ok ? `${c.green}done${c.reset}` : `${c.boldRed}FAIL${c.reset}`;
        const preview = event.data.resultPreview
          ? ` ${c.dim}${truncate(String(event.data.resultPreview).replace(/\n/g, " "), 60)}${c.reset}`
          : "";
        console.log(
          `${c.dim}${ts}${c.reset}${tab}   ${icon} ${c.dim}${dur}${c.reset}${preview}`
        );
        break;
      }
      case "error": {
        console.log(
          `${c.dim}${ts}${c.reset}${tab} ${c.boldRed}ERROR:${c.reset} ${c.red}${truncate(String(event.data.error || ""), 100)}${c.reset}`
        );
        break;
      }
      case "tab_switch": {
        console.log(
          `${c.dim}${ts}${c.reset} ${c.blue}tab switch -> ${event.data.toTabName}${c.reset}`
        );
        break;
      }
      case "step": {
        const tokens = event.data.totalTokens as number;
        const text = event.data.text
          ? ` ${c.dim}${truncate(String(event.data.text).replace(/\n/g, " "), 60)}${c.reset}`
          : "";
        console.log(
          `${c.dim}${ts}${c.reset}${tab} ${c.dim}step #${event.data.stepNumber} (+${tokens} tokens)${c.reset}${text}`
        );
        break;
      }
      default: {
        console.log(
          `${c.dim}${ts}${c.reset}${tab} ${c.dim}${event.type}: ${truncate(JSON.stringify(event.data), 80)}${c.reset}`
        );
      }
    }
  }
}

function cmdExport(id: string): void {
  const session = loadSession(id);
  if (!session) {
    console.error(`Session not found: ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify(session, null, 2));
}

function cmdTail(): void {
  const files = listSessionFiles();
  if (files.length === 0) {
    console.log(`${c.yellow}No sessions to tail.${c.reset}`);
    return;
  }

  const latestFile = path.join(SESSIONS_DIR, files[0]);
  const isJsonl = files[0].endsWith(".jsonl");
  console.log(
    `${c.boldCyan}Tailing: ${files[0]}${c.reset} ${c.dim}(Ctrl+C to stop)${c.reset}\n`
  );

  let lastLineCount = 0;

  function printNewLines(): void {
    try {
      const raw = fs.readFileSync(latestFile, "utf-8");

      if (isJsonl) {
        const lines = raw.split("\n").filter(Boolean);
        const newLines = lines.slice(lastLineCount);
        lastLineCount = lines.length;

        for (const line of newLines) {
          try {
            const entry = JSON.parse(line);
            const ts = entry.timestamp
              ? shortTimestamp(entry.timestamp)
              : "?";
            printJsonlEvent(ts, entry);
          } catch {
            // skip malformed line
          }
        }
      } else {
        // Legacy .json format
        const session = JSON.parse(raw);
        const newEvents = (session.events || []).slice(lastLineCount);
        lastLineCount = (session.events || []).length;

        for (const event of newEvents) {
          const ts = shortTimestamp(event.timestamp);
          printLegacyEvent(ts, event);
        }
      }
    } catch {
      // File might be mid-write
    }
  }

  function printJsonlEvent(
    ts: string,
    entry: Record<string, unknown>
  ): void {
    switch (entry.type) {
      case "user_message": {
        const msg = entry.message as Record<string, unknown> | undefined;
        const content = truncate(
          String(msg?.content || "").replace(/\n/g, " "),
          120
        );
        console.log(
          `${c.dim}${ts}${c.reset} ${c.cyan}[user] ${content}${c.reset}`
        );
        break;
      }
      case "assistant_message": {
        const msg = entry.message as Record<string, unknown> | undefined;
        const content = truncate(
          String(msg?.content || "").replace(/\n/g, " "),
          120
        );
        console.log(
          `${c.dim}${ts}${c.reset} ${c.green}[assistant] ${content}${c.reset}`
        );
        break;
      }
      case "tool_call": {
        const tc = entry.toolCall as Record<string, unknown> | undefined;
        console.log(
          `${c.dim}${ts}${c.reset} ${c.boldMagenta}[tool] ${tc?.name || "?"}${c.reset} ${c.dim}${truncate(JSON.stringify(tc?.arguments || {}), 60)}${c.reset}`
        );
        break;
      }
      case "tool_result": {
        const ok = entry.success as boolean;
        const dur = formatDuration((entry.durationMs as number) || 0);
        if (ok) {
          console.log(
            `${c.dim}${ts}${c.reset} ${c.green}[done] ${dur}${c.reset}`
          );
        } else {
          console.log(
            `${c.dim}${ts}${c.reset} ${c.boldRed}[FAIL] ${dur} ${truncate(String(entry.result || ""), 80)}${c.reset}`
          );
        }
        break;
      }
      case "error": {
        const err = entry.error as Record<string, unknown> | undefined;
        console.log(
          `${c.dim}${ts}${c.reset} ${c.boldRed}[ERROR] ${truncate(String(err?.message || ""), 100)}${c.reset}`
        );
        break;
      }
      case "step_finish": {
        const tokens = (entry.totalTokens as number) || 0;
        console.log(
          `${c.dim}${ts}${c.reset} ${c.dim}[step #${entry.stepNumber}] +${tokens} tokens${c.reset}`
        );
        break;
      }
      case "tab_switch": {
        console.log(
          `${c.dim}${ts}${c.reset} ${c.blue}[tab] -> ${entry.toTabName}${c.reset}`
        );
        break;
      }
      case "session_start": {
        const meta = entry.meta as Record<string, unknown> | undefined;
        const agent = meta?.agent as Record<string, unknown> | undefined;
        console.log(
          `${c.dim}${ts}${c.reset} ${c.boldCyan}[session_start] model=${agent?.model || "?"}${c.reset}`
        );
        break;
      }
      case "session_end": {
        const summary = entry.summary as Record<string, unknown> | undefined;
        const dur = formatDuration((summary?.durationMs as number) || 0);
        console.log(
          `${c.dim}${ts}${c.reset} ${c.boldCyan}[session_end] ${dur} | exit=${summary?.exitReason || "?"}${c.reset}`
        );
        break;
      }
      default: {
        console.log(
          `${c.dim}${ts}${c.reset} ${c.dim}[${entry.type}] ${truncate(JSON.stringify(entry), 80)}${c.reset}`
        );
      }
    }
  }

  function printLegacyEvent(
    ts: string,
    event: Record<string, unknown>
  ): void {
    const data = (event.data as Record<string, unknown>) || {};
    switch (event.type) {
      case "message": {
        const role = data.role as string;
        const content = truncate(
          String(data.content || "").replace(/\n/g, " "),
          120
        );
        if (role === "user") {
          console.log(
            `${c.dim}${ts}${c.reset} ${c.cyan}[user] ${content}${c.reset}`
          );
        } else if (role === "assistant") {
          console.log(
            `${c.dim}${ts}${c.reset} ${c.green}[assistant] ${content}${c.reset}`
          );
        } else {
          console.log(
            `${c.dim}${ts}${c.reset} ${c.yellow}[${role}] ${content}${c.reset}`
          );
        }
        break;
      }
      case "tool_start": {
        console.log(
          `${c.dim}${ts}${c.reset} ${c.boldMagenta}[tool] ${data.toolName}${c.reset} ${c.dim}${truncate(JSON.stringify(data.args || {}), 60)}${c.reset}`
        );
        break;
      }
      case "tool_end": {
        const ok = data.success as boolean;
        const dur = formatDuration((data.durationMs as number) || 0);
        if (ok) {
          console.log(
            `${c.dim}${ts}${c.reset} ${c.green}[done] ${dur}${c.reset}`
          );
        } else {
          console.log(
            `${c.dim}${ts}${c.reset} ${c.boldRed}[FAIL] ${dur} ${truncate(String(data.resultPreview || ""), 80)}${c.reset}`
          );
        }
        break;
      }
      case "error": {
        console.log(
          `${c.dim}${ts}${c.reset} ${c.boldRed}[ERROR] ${truncate(String(data.error || ""), 100)}${c.reset}`
        );
        break;
      }
      case "tab_switch": {
        console.log(
          `${c.dim}${ts}${c.reset} ${c.blue}[tab] -> ${data.toTabName}${c.reset}`
        );
        break;
      }
      default: {
        console.log(
          `${c.dim}${ts}${c.reset} ${c.dim}[${event.type}] ${truncate(JSON.stringify(data), 80)}${c.reset}`
        );
      }
    }
  }

  // Initial read
  printNewLines();

  // Watch for changes
  const watcher = fs.watch(latestFile, () => {
    printNewLines();
  });

  process.on("SIGINT", () => {
    watcher.close();
    console.log(`\n${c.dim}Stopped tailing.${c.reset}`);
    process.exit(0);
  });
}

async function cmdHealth(): Promise<void> {
  console.log(`${c.boldCyan}8gent Health Check${c.reset}\n`);

  // 1. Ollama
  process.stdout.write(`  Ollama: `);
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      const count = data.models?.length ?? 0;
      console.log(`${c.green}running${c.reset} ${c.dim}(${count} models)${c.reset}`);
    } else {
      console.log(`${c.red}error (HTTP ${res.status})${c.reset}`);
    }
  } catch {
    console.log(`${c.red}not running${c.reset}`);
  }

  // 2. LM Studio
  process.stdout.write(`  LM Studio: `);
  try {
    const res = await fetch("http://localhost:1234/v1/models");
    if (res.ok) {
      console.log(`${c.green}running${c.reset}`);
    } else {
      console.log(`${c.dim}not detected${c.reset}`);
    }
  } catch {
    console.log(`${c.dim}not detected${c.reset}`);
  }

  // 3. OpenRouter API key
  process.stdout.write(`  OpenRouter: `);
  if (process.env.OPENROUTER_API_KEY) {
    console.log(`${c.green}API key set${c.reset}`);
  } else {
    console.log(`${c.yellow}no API key${c.reset}`);
  }

  // 4. Auth
  process.stdout.write(`  Auth: `);
  const authPath = path.join(DOT_8GENT, "auth.json");
  if (fs.existsSync(authPath)) {
    console.log(`${c.green}configured${c.reset}`);
  } else {
    console.log(`${c.dim}not configured${c.reset}`);
  }

  // 5. Sessions dir
  process.stdout.write(`  Sessions: `);
  const files = listSessionFiles();
  const jsonlCount = files.filter((f) => f.endsWith(".jsonl")).length;
  const jsonCount = files.filter((f) => f.endsWith(".json")).length;
  console.log(
    `${c.green}${files.length} sessions${c.reset} ${c.dim}(${jsonlCount} jsonl, ${jsonCount} json legacy) in ${SESSIONS_DIR}${c.reset}`
  );

  // 6. Disk usage of ~/.8gent
  process.stdout.write(`  ~/.8gent size: `);
  try {
    const proc = Bun.spawn(["du", "-sh", DOT_8GENT], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const size = output.split("\t")[0]?.trim() || "unknown";
    console.log(`${c.green}${size}${c.reset}`);
  } catch {
    console.log(`${c.dim}unknown${c.reset}`);
  }

  // 7. Bun version
  process.stdout.write(`  Bun: `);
  console.log(`${c.green}${Bun.version}${c.reset}`);

  console.log();
}

function cmdTools(id: string): void {
  const session = loadSession(id);
  if (!session) {
    console.log(`${c.red}Session not found: ${id}${c.reset}`);
    return;
  }

  const toolEvents = session.events.filter(
    (e) => e.type === "tool_start" || e.type === "tool_end"
  );

  if (toolEvents.length === 0) {
    console.log(`${c.yellow}No tool calls in this session.${c.reset}`);
    return;
  }

  console.log(
    `${c.boldCyan}Tool Timeline: ${session.name}${c.reset} ${c.dim}(${session.stats?.toolCalls ?? 0} calls)${c.reset}\n`
  );

  const starts = new Map<
    string,
    { toolName: string; timestamp: string; args: unknown }
  >();

  for (const event of toolEvents) {
    if (event.type === "tool_start") {
      starts.set(event.data.toolCallId as string, {
        toolName: event.data.toolName as string,
        timestamp: event.timestamp,
        args: event.data.args,
      });
    } else if (event.type === "tool_end") {
      const callId = event.data.toolCallId as string;
      const start = starts.get(callId);
      const ok = event.data.success as boolean;
      const dur = formatDuration((event.data.durationMs as number) || 0);
      const ts = start
        ? shortTimestamp(start.timestamp)
        : shortTimestamp(event.timestamp);
      const name = start?.toolName || "?";
      const statusIcon = ok
        ? `${c.green}OK${c.reset}`
        : `${c.boldRed}FAIL${c.reset}`;
      const argsStr = start?.args
        ? ` ${c.dim}${truncate(JSON.stringify(start.args), 50)}${c.reset}`
        : "";

      console.log(
        `  ${c.dim}${ts}${c.reset} ${c.boldMagenta}${name.padEnd(20)}${c.reset} ${statusIcon.padEnd(20)} ${c.dim}${dur.padEnd(8)}${c.reset}${argsStr}`
      );
    }
  }
}

function cmdErrors(id?: string): void {
  if (id) {
    const session = loadSession(id);
    if (!session) {
      console.log(`${c.red}Session not found: ${id}${c.reset}`);
      return;
    }

    const errors = session.events.filter((e) => e.type === "error");
    if (errors.length === 0) {
      console.log(`${c.green}No errors in this session.${c.reset}`);
      return;
    }

    console.log(
      `${c.boldRed}Errors in: ${session.name}${c.reset} ${c.dim}(${errors.length})${c.reset}\n`
    );
    for (const e of errors) {
      console.log(
        `  ${c.dim}${shortTimestamp(e.timestamp)}${c.reset} ${c.red}${e.data.error}${c.reset}`
      );
    }
    return;
  }

  // Errors across all sessions
  const files = listSessionFiles().slice(0, 50);
  let totalErrors = 0;

  console.log(`${c.boldRed}Errors across recent sessions${c.reset}\n`);

  for (const file of files) {
    try {
      const filePath = path.join(SESSIONS_DIR, file);
      const id = file.replace(/\.(jsonl|json)$/, "");
      const session = file.endsWith(".jsonl")
        ? parseJsonlSession(filePath, id)
        : parseLegacyJsonSession(filePath, id);

      const errors = session.events.filter((e) => e.type === "error");
      if (errors.length === 0) continue;

      totalErrors += errors.length;
      console.log(
        `${c.boldCyan}${truncate(session.name, 50)}${c.reset} ${c.dim}(${file})${c.reset}`
      );
      for (const e of errors) {
        console.log(
          `  ${c.dim}${shortTimestamp(e.timestamp)}${c.reset} ${c.red}${truncate(String(e.data.error || ""), 100)}${c.reset}`
        );
      }
      console.log();
    } catch {
      // Skip corrupt files
    }
  }

  if (totalErrors === 0) {
    console.log(`${c.green}No errors found. Nice.${c.reset}`);
  } else {
    console.log(`${c.dim}Total: ${totalErrors} errors${c.reset}`);
  }
}

function usage(): void {
  console.log(`${c.boldCyan}8gent Debug CLI${c.reset}

${c.bold}Usage:${c.reset}
  bun run bin/debug.ts ${c.cyan}<command>${c.reset} [args]

${c.bold}Commands:${c.reset}
  ${c.cyan}sessions${c.reset}              List recent sessions
  ${c.cyan}inspect${c.reset} <id>          Show session detail
  ${c.cyan}export${c.reset} <id>           Export session as JSON to stdout
  ${c.cyan}tail${c.reset}                  Live tail of most recent session
  ${c.cyan}health${c.reset}                System health check
  ${c.cyan}tools${c.reset} <id>            Show tool call timeline for a session
  ${c.cyan}errors${c.reset} [id]           Show errors (all or specific session)

${c.bold}Examples:${c.reset}
  ${c.dim}bun run bin/debug.ts sessions${c.reset}
  ${c.dim}bun run bin/debug.ts inspect 2026-03-20${c.reset}
  ${c.dim}bun run bin/debug.ts tail${c.reset}
  ${c.dim}bun run bin/debug.ts health${c.reset}
`);
}

// ============================================
// Main
// ============================================

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "sessions":
    cmdSessions();
    break;
  case "inspect":
    if (!rest[0]) {
      console.log(`${c.red}Usage: debug.ts inspect <id>${c.reset}`);
      process.exit(1);
    }
    cmdInspect(rest[0]);
    break;
  case "export":
    if (!rest[0]) {
      console.log(`${c.red}Usage: debug.ts export <id>${c.reset}`);
      process.exit(1);
    }
    cmdExport(rest[0]);
    break;
  case "tail":
    cmdTail();
    break;
  case "health":
    await cmdHealth();
    break;
  case "tools":
    if (!rest[0]) {
      console.log(`${c.red}Usage: debug.ts tools <id>${c.reset}`);
      process.exit(1);
    }
    cmdTools(rest[0]);
    break;
  case "errors":
    cmdErrors(rest[0]);
    break;
  default:
    usage();
    break;
}
