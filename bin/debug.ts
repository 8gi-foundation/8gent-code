#!/usr/bin/env bun
/**
 * 8gent Debug CLI — inspect, tail, and analyze TUI sessions.
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
// Helpers
// ============================================

interface SessionLog {
  id: string;
  name: string;
  startedAt: string;
  lastUpdatedAt: string;
  model: string;
  provider: string;
  tabId: string;
  tabName: string;
  events: Array<{
    type: string;
    timestamp: string;
    tabId: string;
    tabName: string;
    data: Record<string, unknown>;
  }>;
  stats: {
    messageCount: number;
    toolCalls: number;
    totalTokens: number;
    errors: number;
    durationMs: number;
  };
}

function listSessionFiles(): string[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
}

function loadSession(fileOrId: string): SessionLog | null {
  // Try exact filename first
  let filePath = path.join(SESSIONS_DIR, fileOrId);
  if (!filePath.endsWith(".json")) filePath += ".json";

  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  // Try partial match on session ID or filename
  const files = listSessionFiles();
  const match = files.find(
    (f) => f.includes(fileOrId) || f.startsWith(fileOrId)
  );
  if (match) {
    return JSON.parse(
      fs.readFileSync(path.join(SESSIONS_DIR, match), "utf-8")
    );
  }

  return null;
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
      const session = JSON.parse(
        fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8")
      ) as SessionLog;
      const id = file.replace(".json", "");
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
  console.log(
    `${c.boldCyan}Tailing: ${files[0]}${c.reset} ${c.dim}(Ctrl+C to stop)${c.reset}\n`
  );

  let lastEventCount = 0;

  function printNewEvents(): void {
    try {
      const raw = fs.readFileSync(latestFile, "utf-8");
      const session = JSON.parse(raw) as SessionLog;
      const newEvents = session.events.slice(lastEventCount);
      lastEventCount = session.events.length;

      for (const event of newEvents) {
        const ts = shortTimestamp(event.timestamp);
        switch (event.type) {
          case "message": {
            const role = event.data.role as string;
            const content = truncate(
              String(event.data.content || "").replace(/\n/g, " "),
              120
            );
            if (role === "user") {
              console.log(`${c.dim}${ts}${c.reset} ${c.cyan}[user] ${content}${c.reset}`);
            } else if (role === "assistant") {
              console.log(`${c.dim}${ts}${c.reset} ${c.green}[assistant] ${content}${c.reset}`);
            } else {
              console.log(`${c.dim}${ts}${c.reset} ${c.yellow}[${role}] ${content}${c.reset}`);
            }
            break;
          }
          case "tool_start": {
            console.log(
              `${c.dim}${ts}${c.reset} ${c.boldMagenta}[tool] ${event.data.toolName}${c.reset} ${c.dim}${truncate(JSON.stringify(event.data.args || {}), 60)}${c.reset}`
            );
            break;
          }
          case "tool_end": {
            const ok = event.data.success as boolean;
            const dur = formatDuration((event.data.durationMs as number) || 0);
            if (ok) {
              console.log(`${c.dim}${ts}${c.reset} ${c.green}[done] ${dur}${c.reset}`);
            } else {
              console.log(
                `${c.dim}${ts}${c.reset} ${c.boldRed}[FAIL] ${dur} ${truncate(String(event.data.resultPreview || ""), 80)}${c.reset}`
              );
            }
            break;
          }
          case "error": {
            console.log(
              `${c.dim}${ts}${c.reset} ${c.boldRed}[ERROR] ${truncate(String(event.data.error || ""), 100)}${c.reset}`
            );
            break;
          }
          case "tab_switch": {
            console.log(
              `${c.dim}${ts}${c.reset} ${c.blue}[tab] -> ${event.data.toTabName}${c.reset}`
            );
            break;
          }
          default: {
            console.log(
              `${c.dim}${ts}${c.reset} ${c.dim}[${event.type}] ${truncate(JSON.stringify(event.data), 80)}${c.reset}`
            );
          }
        }
      }
    } catch {
      // File might be mid-write
    }
  }

  // Initial read
  printNewEvents();

  // Watch for changes
  const watcher = fs.watch(latestFile, () => {
    printNewEvents();
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
  console.log(
    `${c.green}${files.length} sessions${c.reset} ${c.dim}in ${SESSIONS_DIR}${c.reset}`
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

  // Build timeline of start/end pairs
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
    // Errors for specific session
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
      const session = JSON.parse(
        fs.readFileSync(path.join(SESSIONS_DIR, file), "utf-8")
      ) as SessionLog;
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
