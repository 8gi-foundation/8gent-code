/**
 * 8gent CLUI Bridge
 *
 * Runs the Agent in NDJSON mode for the CLUI desktop app.
 * Reads prompts from stdin (one per line), writes NDJSON events to stdout.
 *
 * Usage: EIGHT_CLUI_MODE=true bun run packages/eight/clui-bridge.ts
 *
 * Events emitted (one JSON object per line):
 *   { type: "session_start", model, cwd }
 *   { type: "thinking", content }
 *   { type: "text", content }
 *   { type: "tool_start", toolName, args, toolCallId }
 *   { type: "tool_end", toolName, success, resultPreview, durationMs }
 *   { type: "assistant_message", content }
 *   { type: "error", message }
 *   { type: "session_end", reason }
 */

import * as readline from "readline";
import { Agent } from "./agent.js";
import type { AgentConfig } from "./types.js";

function emit(event: Record<string, any>) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function main() {
  const model = process.env.EIGHT_MODEL || "eight:latest";
  const sessionId = process.env.EIGHT_SESSION_ID || `clui_${Date.now()}`;
  const runtime = (process.env.EIGHT_RUNTIME || "ollama") as "ollama" | "lmstudio" | "openrouter";
  const cwd = process.cwd();

  emit({ type: "session_start", model, cwd, sessionId });

  // Create the agent with event callbacks that emit NDJSON
  const agent = new Agent({
    model,
    runtime,
    workingDirectory: cwd,
    maxTurns: 50,
    apiKey: process.env.OPENROUTER_API_KEY,
    events: {
      onToolStart: (event) => {
        emit({
          type: "tool_start",
          toolName: event.toolName,
          args: event.args,
          toolCallId: event.toolCallId,
        });
      },
      onToolEnd: (event) => {
        emit({
          type: "tool_end",
          toolName: event.toolName,
          success: event.success,
          resultPreview: event.resultPreview?.slice(0, 200),
          durationMs: event.durationMs,
          toolCallId: event.toolCallId,
        });
      },
      onStep: (event) => {
        emit({
          type: "step",
          stepNumber: event.stepNumber,
          totalSteps: event.totalSteps,
        });
      },
      onEvidence: (event) => {
        emit({
          type: "evidence",
          evidence: {
            type: event.evidence.type,
            description: event.evidence.description,
            verified: event.evidence.verified,
          },
        });
      },
      onEvidenceSummary: (event) => {
        emit({
          type: "evidence_summary",
          total: event.total,
          verified: event.verified,
          failed: event.failed,
        });
      },
    },
  });

  // Read prompts from stdin, line by line
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  emit({ type: "ready", message: "Agent ready. Send prompts via stdin." });

  rl.on("line", async (line: string) => {
    const prompt = line.trim();
    if (!prompt) return;

    emit({ type: "thinking", content: "Processing..." });

    try {
      const response = await agent.chat(prompt);
      emit({
        type: "assistant_message",
        content: response,
      });
    } catch (err: any) {
      emit({
        type: "error",
        message: err.message || String(err),
      });
    }
  });

  rl.on("close", async () => {
    emit({ type: "session_end", reason: "stdin closed" });
    await agent.cleanup().catch(() => {});
    process.exit(0);
  });

  // Handle graceful shutdown
  process.on("SIGTERM", async () => {
    emit({ type: "session_end", reason: "SIGTERM" });
    await agent.cleanup().catch(() => {});
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    emit({ type: "session_end", reason: "SIGINT" });
    await agent.cleanup().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  emit({ type: "error", message: `Fatal: ${err.message}` });
  process.exit(1);
});
