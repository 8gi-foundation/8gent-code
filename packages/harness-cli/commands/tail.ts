/**
 * harness-cli: tail command
 *
 * Live-tail a running session file, printing new entries as they appear.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SESSIONS_DIR = path.join(os.homedir(), ".8gent", "sessions");

function resolveSessionPath(sessionId: string): string {
  if (fs.existsSync(sessionId)) return sessionId;
  const withExt = sessionId.endsWith(".jsonl") ? sessionId : `${sessionId}.jsonl`;
  const fullPath = path.join(SESSIONS_DIR, withExt);
  if (fs.existsSync(fullPath)) return fullPath;
  if (fs.existsSync(SESSIONS_DIR)) {
    const files = fs.readdirSync(SESSIONS_DIR);
    const match = files.find(f => f.startsWith(sessionId));
    if (match) return path.join(SESSIONS_DIR, match);
  }
  throw new Error(`Session not found: ${sessionId}`);
}

export async function tail(args: string[]): Promise<void> {
  const sessionId = args.find(a => !a.startsWith("-")) ?? "";

  if (!sessionId) {
    console.error("Usage: harness-cli tail <session-id>");
    process.exit(1);
  }

  const filePath = resolveSessionPath(sessionId);
  console.log(`[tail] Watching: ${filePath}`);
  console.log(`[tail] Press Ctrl+C to stop\n`);

  let position = 0;
  let buffer = "";

  function readNew() {
    const stat = fs.statSync(filePath);
    if (stat.size > position) {
      const fd = fs.openSync(filePath, "r");
      const chunk = Buffer.alloc(stat.size - position);
      fs.readSync(fd, chunk, 0, chunk.length, position);
      fs.closeSync(fd);
      position = stat.size;

      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "??:??";
          const type = entry.type;

          let summary = "";
          switch (type) {
            case "user_message":
              summary = (entry.message?.content ?? "").slice(0, 100);
              break;
            case "assistant_content": {
              const texts = (entry.parts ?? [])
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join(" ");
              summary = texts.slice(0, 100);
              break;
            }
            case "tool_call":
              summary = `${entry.toolCall?.name}(${JSON.stringify(entry.toolCall?.arguments).slice(0, 60)})`;
              break;
            case "tool_result":
              summary = `${entry.success ? "✓" : "✗"} ${entry.toolName ?? ""} ${(entry.result ?? "").slice(0, 60)}`;
              break;
            case "tool_error":
              summary = `${entry.toolName}: ${entry.error?.slice(0, 80)}`;
              break;
            case "step_end":
              summary = `step #${entry.stepNumber} → ${entry.finishReason} [${entry.usage?.totalTokens ?? "?"}tok]`;
              break;
            case "error":
              summary = entry.error?.message ?? "?";
              break;
            case "session_end":
              summary = `exit=${entry.summary?.exitReason} steps=${entry.summary?.totalSteps} tokens=${entry.summary?.totalTokens}`;
              break;
            default:
              summary = JSON.stringify(entry).slice(0, 80);
          }

          console.log(`  ${ts} [${type}] ${summary}`);

          if (type === "session_end") {
            console.log("\n[tail] Session ended.");
            process.exit(0);
          }
        } catch {
          console.log(`  [raw] ${line.slice(0, 100)}`);
        }
      }
    }
  }

  // Initial read
  readNew();

  // Poll for changes
  const watcher = fs.watchFile(filePath, { interval: 500 }, () => {
    readNew();
  });

  // Also poll on interval as backup
  const interval = setInterval(readNew, 1000);

  process.on("SIGINT", () => {
    fs.unwatchFile(filePath);
    clearInterval(interval);
    console.log("\n[tail] Stopped.");
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {});
}
