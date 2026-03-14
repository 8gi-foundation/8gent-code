/**
 * harness-cli: inspect command
 *
 * Shows the full contents of a session file — every entry, tool call,
 * assistant message, and error. The primary debugging tool.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import type { SessionEntry } from "../../specifications/session/index.js";

const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");

interface InspectOptions {
  sessionId: string;
  json: boolean;
  entryTypes: string[] | null;
  summary: boolean;
}

function parseArgs(args: string[]): InspectOptions {
  const opts: InspectOptions = {
    sessionId: "",
    json: false,
    entryTypes: null,
    summary: false,
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--json":
        opts.json = true;
        break;
      case "--entries":
        opts.entryTypes = args[++i].split(",");
        break;
      case "--summary":
        opts.summary = true;
        break;
      default:
        if (!opts.sessionId) opts.sessionId = args[i];
    }
    i++;
  }
  return opts;
}

function resolveSessionPath(sessionId: string): string {
  // Accept full path, or just session ID
  if (fs.existsSync(sessionId)) return sessionId;

  const withExt = sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`;
  const fullPath = path.join(SESSIONS_DIR, withExt);

  if (fs.existsSync(fullPath)) return fullPath;

  // Fuzzy match — find sessions starting with the given prefix
  if (fs.existsSync(SESSIONS_DIR)) {
    const files = fs.readdirSync(SESSIONS_DIR);
    const match = files.find(f => f.startsWith(sessionId));
    if (match) return path.join(SESSIONS_DIR, match);
  }

  throw new Error(`Session not found: ${sessionId}\nLooked in: ${SESSIONS_DIR}`);
}

async function readEntries(filePath: string): Promise<SessionEntry[]> {
  const entries: SessionEntry[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // skip malformed
    }
  }
  return entries;
}

function formatEntry(entry: SessionEntry, index: number): string {
  const seq = entry.sequenceNumber ?? index;
  const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "??:??:??";
  const type = entry.type;

  const lines: string[] = [];
  const header = `  [${seq}] ${ts} ${typeLabel(type)}`;

  switch (type) {
    case "session_start": {
      const meta = (entry as any).meta;
      lines.push(header);
      lines.push(`       Version: ${meta?.version ?? 1}`);
      lines.push(`       Model: ${meta?.agent?.model ?? "?"} (${meta?.agent?.runtime ?? "?"})`);
      lines.push(`       Dir: ${meta?.environment?.workingDirectory ?? "?"}`);
      if (meta?.environment?.gitBranch) {
        lines.push(`       Branch: ${meta.environment.gitBranch}`);
      }
      break;
    }
    case "user_message": {
      const content = (entry as any).message?.content ?? "";
      lines.push(header);
      lines.push(`       ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`);
      break;
    }
    case "assistant_message": {
      const content = (entry as any).message?.content ?? "";
      lines.push(header);
      lines.push(`       ${content.slice(0, 300)}${content.length > 300 ? "..." : ""}`);
      break;
    }
    case "assistant_content": {
      const parts = (entry as any).parts ?? [];
      const usage = (entry as any).usage;
      lines.push(header + (usage ? ` [${usage.totalTokens} tok]` : ""));
      for (const p of parts) {
        if (p.type === "text") {
          lines.push(`       [text] ${(p.text ?? "").slice(0, 300)}${(p.text ?? "").length > 300 ? "..." : ""}`);
        } else if (p.type === "reasoning") {
          lines.push(`       [think] ${(p.text ?? "").slice(0, 200)}...`);
        } else if (p.type === "tool-call") {
          lines.push(`       [tool-call] ${p.toolName}(${JSON.stringify(p.args).slice(0, 80)})`);
        } else if (p.type === "tool-result") {
          lines.push(`       [tool-result] ${p.toolName}: ${String(p.result).slice(0, 80)}`);
        } else {
          lines.push(`       [${p.type}]`);
        }
      }
      break;
    }
    case "tool_call": {
      const tc = (entry as any).toolCall;
      lines.push(header);
      lines.push(`       ${tc?.name ?? "?"}(${JSON.stringify(tc?.arguments ?? {}).slice(0, 120)})`);
      break;
    }
    case "tool_result": {
      const success = (entry as any).success;
      const result = (entry as any).result ?? "";
      const dur = (entry as any).durationMs;
      const name = (entry as any).toolName ?? "";
      const icon = success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      lines.push(`${header} ${icon} ${name}${dur ? ` (${dur}ms)` : ""}`);
      if (result) {
        lines.push(`       ${result.slice(0, 200)}${result.length > 200 ? "..." : ""}`);
      }
      break;
    }
    case "tool_error": {
      const toolName = (entry as any).toolName ?? "?";
      const error = (entry as any).error ?? "";
      lines.push(`${header} \x1b[31m${toolName}\x1b[0m`);
      lines.push(`       ${error.slice(0, 300)}`);
      break;
    }
    case "step_start": {
      const step = (entry as any).stepNumber ?? "?";
      lines.push(`${header} Step #${step}`);
      break;
    }
    case "step_end": {
      const step = (entry as any).stepNumber ?? "?";
      const reason = (entry as any).finishReason ?? "?";
      const usage = (entry as any).usage;
      lines.push(`${header} Step #${step} → ${reason}${usage ? ` [${usage.totalTokens} tok]` : ""}`);
      break;
    }
    case "error": {
      const err = (entry as any).error;
      lines.push(`${header} \x1b[31m${err?.message ?? "Unknown error"}\x1b[0m`);
      if (err?.code) lines.push(`       Code: ${err.code}`);
      break;
    }
    case "session_end": {
      const sum = (entry as any).summary;
      lines.push(header);
      lines.push(`       Exit: ${sum?.exitReason ?? "?"}`);
      lines.push(`       Duration: ${sum?.durationMs ? (sum.durationMs / 1000).toFixed(1) + "s" : "?"}`);
      lines.push(`       Steps: ${sum?.totalSteps ?? sum?.totalTurns ?? "?"}`);
      lines.push(`       Tool calls: ${sum?.totalToolCalls ?? "?"}`);
      lines.push(`       Tokens: ${sum?.totalTokens ?? sum?.totalUsage?.totalTokens ?? "?"}`);
      if (sum?.filesCreated?.length) lines.push(`       Created: ${sum.filesCreated.join(", ")}`);
      if (sum?.filesModified?.length) lines.push(`       Modified: ${sum.filesModified.join(", ")}`);
      if (sum?.gitCommits?.length) lines.push(`       Commits: ${sum.gitCommits.join(", ")}`);
      break;
    }
    default: {
      lines.push(`${header}`);
      const keys = Object.keys(entry).filter(k => !["type", "timestamp", "sequenceNumber"].includes(k));
      if (keys.length > 0) {
        lines.push(`       ${JSON.stringify(entry).slice(0, 200)}`);
      }
    }
  }

  return lines.join("\n");
}

function typeLabel(type: string): string {
  const colors: Record<string, string> = {
    session_start: "\x1b[36m",    // cyan
    session_end: "\x1b[36m",
    user_message: "\x1b[34m",     // blue
    assistant_message: "\x1b[32m", // green
    assistant_content: "\x1b[32m",
    tool_call: "\x1b[33m",        // yellow
    tool_result: "\x1b[33m",
    tool_error: "\x1b[31m",       // red
    error: "\x1b[31m",
    step_start: "\x1b[35m",       // magenta
    step_end: "\x1b[35m",
  };
  const color = colors[type] || "";
  const reset = color ? "\x1b[0m" : "";
  return `${color}${type}${reset}`;
}

function printSummary(entries: SessionEntry[]): void {
  const counts: Record<string, number> = {};
  let firstUser = "";
  let lastAssistant = "";
  let totalTokens = 0;
  let errors: string[] = [];

  for (const e of entries) {
    counts[e.type] = (counts[e.type] || 0) + 1;

    if (e.type === "user_message" && !firstUser) {
      firstUser = (e as any).message?.content?.slice(0, 120) ?? "";
    }
    if (e.type === "assistant_content") {
      const parts = (e as any).parts ?? [];
      const textPart = parts.find((p: any) => p.type === "text");
      if (textPart) lastAssistant = textPart.text?.slice(0, 300) ?? "";
    }
    if (e.type === "assistant_message") {
      lastAssistant = (e as any).message?.content?.slice(0, 300) ?? "";
    }
    if (e.type === "step_end" && (e as any).usage?.totalTokens) {
      totalTokens += (e as any).usage.totalTokens;
    }
    if (e.type === "error") {
      errors.push((e as any).error?.message ?? "Unknown");
    }
    if (e.type === "tool_error") {
      errors.push(`${(e as any).toolName}: ${(e as any).error}`);
    }
  }

  const sessionEnd = entries.find(e => e.type === "session_end") as any;

  console.log("\n  Session Summary");
  console.log("  " + "─".repeat(60));
  console.log(`  Entries: ${entries.length}`);
  console.log(`  Types: ${Object.entries(counts).map(([k, v]) => `${k}(${v})`).join(", ")}`);
  console.log(`  First prompt: ${firstUser || "—"}`);
  console.log(`  Last response: ${lastAssistant.slice(0, 150) || "—"}${lastAssistant.length > 150 ? "..." : ""}`);
  console.log(`  Total tokens: ${totalTokens || sessionEnd?.summary?.totalTokens || "?"}`);

  if (sessionEnd) {
    console.log(`  Exit reason: ${sessionEnd.summary?.exitReason ?? "?"}`);
    console.log(`  Duration: ${sessionEnd.summary?.durationMs ? (sessionEnd.summary.durationMs / 1000).toFixed(1) + "s" : "?"}`);
    console.log(`  Steps: ${sessionEnd.summary?.totalSteps ?? "?"}`);
    console.log(`  Tool calls: ${sessionEnd.summary?.totalToolCalls ?? "?"}`);
    if (sessionEnd.summary?.filesCreated?.length) {
      console.log(`  Files created: ${sessionEnd.summary.filesCreated.join(", ")}`);
    }
    if (sessionEnd.summary?.filesModified?.length) {
      console.log(`  Files modified: ${sessionEnd.summary.filesModified.join(", ")}`);
    }
  } else {
    console.log(`  Status: \x1b[33mRUNNING (no session_end found)\x1b[0m`);
  }

  if (errors.length > 0) {
    console.log(`  \x1b[31mErrors (${errors.length}):\x1b[0m`);
    for (const err of errors.slice(0, 10)) {
      console.log(`    - ${err.slice(0, 120)}`);
    }
  }
  console.log();
}

export async function inspect(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (!opts.sessionId) {
    console.error("Usage: harness-cli inspect <session-id>");
    process.exit(1);
  }

  const filePath = resolveSessionPath(opts.sessionId);
  const entries = await readEntries(filePath);

  // Filter by entry type if requested
  let filtered = entries;
  if (opts.entryTypes) {
    filtered = entries.filter(e => opts.entryTypes!.includes(e.type));
  }

  if (opts.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (opts.summary) {
    printSummary(entries);
    return;
  }

  console.log(`\n  Session: ${opts.sessionId}`);
  console.log(`  File: ${filePath}`);
  console.log(`  Entries: ${entries.length}`);
  console.log("  " + "─".repeat(60));

  for (let i = 0; i < filtered.length; i++) {
    console.log(formatEntry(filtered[i], i));
  }

  // Print summary at the end
  printSummary(entries);
}
