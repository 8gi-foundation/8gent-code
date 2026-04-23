/**
 * 8gent Code - `run` Subcommand (one-shot agent runner)
 *
 * Entry point for Orchestra, cmux, and other terminal hosts that want to
 * spawn 8gent as a headless agent via:
 *
 *   8gent run --yes --output-format stream-json "<prompt>"
 *
 * Emits NDJSON events to stdout (one JSON object per line) when
 * `--output-format stream-json` is set. Otherwise, falls back to plain
 * text output of the final assistant message.
 *
 * Event shape is a best-effort match for the Claude Code stream-json
 * format: a `{type, subtype, ...}` discriminated union with `session_start`,
 * `assistant`, `tool_use`, `tool_result`, and `session_end` types. If an
 * external harness disagrees with this shape, the chosen shape is logged to
 * stderr so the downstream parser can be adjusted without a round-trip to
 * the agent loop.
 */
import type { AgentEventCallbacks } from "./types";

export interface RunOptions {
  prompt: string;
  yes: boolean;
  outputFormat: "text" | "stream-json";
  provider?: string;
  model?: string;
  cwd?: string;
  maxTurns?: number;
}

/**
 * Parse argv for the `run` subcommand. `argv` here is everything after
 * the `run` token itself.
 *
 * Supported:
 *   --yes
 *   --output-format <fmt>        or --output-format=<fmt>
 *   --provider <name>            or --provider=<name>
 *   --model <name>               or --model=<name>
 *   --cwd <dir>                  or --cwd=<dir>
 *   --max-turns <n>              or --max-turns=<n>
 *   <prompt tokens...>           everything positional, joined with spaces
 */
export function parseRunArgs(argv: string[]): RunOptions {
  let yes = false;
  let outputFormat: "text" | "stream-json" = "text";
  let provider: string | undefined;
  let model: string | undefined;
  let cwd: string | undefined;
  let maxTurns: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
      continue;
    }
    // --output-format <fmt> or --output-format=<fmt>
    if (a === "--output-format") {
      const next = argv[i + 1];
      if (next) {
        outputFormat = next === "stream-json" ? "stream-json" : "text";
        i++;
      }
      continue;
    }
    if (a.startsWith("--output-format=")) {
      const v = a.slice("--output-format=".length);
      outputFormat = v === "stream-json" ? "stream-json" : "text";
      continue;
    }
    if (a === "--provider") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { provider = next; i++; }
      continue;
    }
    if (a.startsWith("--provider=")) { provider = a.slice("--provider=".length); continue; }
    if (a === "--model") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { model = next; i++; }
      continue;
    }
    if (a.startsWith("--model=")) { model = a.slice("--model=".length); continue; }
    if (a === "--cwd") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { cwd = next; i++; }
      continue;
    }
    if (a.startsWith("--cwd=")) { cwd = a.slice("--cwd=".length); continue; }
    if (a === "--max-turns") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) { maxTurns = parseInt(next, 10); i++; }
      continue;
    }
    if (a.startsWith("--max-turns=")) { maxTurns = parseInt(a.slice("--max-turns=".length), 10); continue; }
    // Any other flag is ignored silently so Orchestra can pass extras
    if (a.startsWith("-")) continue;
    positional.push(a);
  }

  return {
    prompt: positional.join(" ").trim(),
    yes,
    outputFormat,
    provider,
    model,
    cwd,
    maxTurns,
  };
}

/**
 * Emit a single NDJSON event to stdout. Keep stdout exclusively for events
 * so external parsers never have to disambiguate. All log / diagnostic
 * output goes to stderr.
 */
function emit(obj: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    // If stdout is closed (parent died), nothing we can do.
  }
}

/**
 * Pick a sensible default model for the active provider when the caller did
 * not specify one. We keep this conservative: Ollama gets `qwen3:14b`,
 * everything else gets `auto:free` which the provider manager understands.
 */
function defaultModelFor(provider: string): string {
  switch (provider) {
    case "ollama":
      return "qwen3:14b";
    case "lmstudio":
      return "local-model";
    case "8gent":
      return "eight-1.0-q3:14b";
    case "openrouter":
      return "auto:free";
    default:
      return "qwen3:14b";
  }
}

/**
 * Dynamically auto-detect an available Ollama model if none was specified.
 * Returns null if Ollama is unreachable or has no models.
 */
async function autoDetectOllamaModel(): Promise<string | null> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const names = (data.models || []).map((m) => m.name);
    return (
      names.find((n) => n.startsWith("eight")) ||
      names.find((n) => !n.includes("embed")) ||
      null
    );
  } catch {
    return null;
  }
}

export async function runRunCommand(argv: string[]): Promise<number> {
  const opts = parseRunArgs(argv);

  if (!opts.prompt) {
    const err = "Error: `8gent run` requires a prompt. Usage: 8gent run [--yes] [--output-format stream-json] \"<prompt>\"";
    if (opts.outputFormat === "stream-json") {
      emit({ type: "error", subtype: "usage", message: err });
    } else {
      process.stderr.write(err + "\n");
    }
    return 1;
  }

  // --yes: auto-approve tool calls for the duration of this run.
  // NemoClaw's PermissionManager.setAutoApprove(true) bypasses prompts for
  // non-dangerous commands. Catastrophic commands (rm -rf /, push to main
  // via its own guard, etc.) remain blocked.
  if (opts.yes) {
    try {
      const perms = await import("../permissions");
      perms.getPermissionManager().setAutoApprove(true);
    } catch (err) {
      process.stderr.write(`[run] warn: could not enable auto-approve: ${String(err)}\n`);
    }
  }

  // Resolve provider + model.
  const provider = opts.provider || "ollama";
  let model = opts.model;
  if (!model) {
    if (provider === "ollama") {
      model = (await autoDetectOllamaModel()) || defaultModelFor(provider);
    } else {
      model = defaultModelFor(provider);
    }
  }

  // Note to downstream harnesses: which stream-json shape we picked.
  // Goes to stderr so stdout stays clean NDJSON.
  if (opts.outputFormat === "stream-json") {
    process.stderr.write(
      `[run] stream-json shape: {type, subtype?, ...fields}. ` +
      `Types: session_start, assistant, tool_use, tool_result, session_end, error.\n`
    );
  }

  const sessionStartedAt = new Date().toISOString();

  const isStreamJson = opts.outputFormat === "stream-json";
  const events: AgentEventCallbacks = isStreamJson
    ? {
        onToolStart: (e) => {
          emit({
            type: "tool_use",
            subtype: "start",
            tool_call_id: e.toolCallId,
            tool_name: e.toolName,
            step: e.stepNumber ?? null,
            input: e.args,
          });
        },
        onToolEnd: (e) => {
          emit({
            type: "tool_result",
            subtype: e.success ? "ok" : "error",
            tool_call_id: e.toolCallId,
            tool_name: e.toolName,
            step: e.stepNumber ?? null,
            success: e.success,
            duration_ms: e.durationMs,
            result_preview: e.resultPreview ?? "",
          });
        },
        onStepFinish: (e) => {
          if (e.text) {
            emit({
              type: "assistant",
              subtype: "text",
              step: e.stepNumber,
              finish_reason: e.finishReason,
              text: e.text,
              usage: e.usage,
            });
          }
          if (e.toolCalls && e.toolCalls.length > 0) {
            emit({
              type: "assistant",
              subtype: "tool_calls",
              step: e.stepNumber,
              finish_reason: e.finishReason,
              tool_calls: e.toolCalls,
              usage: e.usage,
            });
          }
        },
      }
    : {};

  if (isStreamJson) {
    emit({
      type: "session_start",
      started_at: sessionStartedAt,
      provider,
      model,
      cwd: opts.cwd || process.cwd(),
    });
  }

  // When emitting NDJSON, stdout must be reserved exclusively for events so
  // the external parser never has to disambiguate. Agent internals log via
  // `console.log` (AST indexer, loop detector, privacy gate, etc.); redirect
  // those to stderr for the duration of the run. Restored in `finally`.
  const originalConsoleLog = console.log;
  const originalConsoleInfo = console.info;
  if (isStreamJson) {
    console.log = (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    };
    console.info = console.log;
  }

  let exitCode = 0;
  try {
    const { Agent } = await import("./agent");
    const agent = new Agent({
      model,
      runtime: provider as "ollama" | "lmstudio" | "openrouter" | "apple-foundation",
      workingDirectory: opts.cwd || process.cwd(),
      maxTurns: opts.maxTurns ?? 30,
      events,
    });

    const finalText = await agent.chat(opts.prompt);

    if (isStreamJson) {
      emit({
        type: "session_end",
        subtype: "ok",
        ended_at: new Date().toISOString(),
        final_text: finalText,
      });
    } else {
      process.stdout.write(finalText + "\n");
    }

    await agent.cleanup();
  } catch (err) {
    exitCode = 1;
    const msg = err instanceof Error ? err.message : String(err);
    if (isStreamJson) {
      emit({ type: "error", subtype: "agent", message: msg });
      emit({
        type: "session_end",
        subtype: "error",
        ended_at: new Date().toISOString(),
        error: msg,
      });
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
  } finally {
    if (isStreamJson) {
      console.log = originalConsoleLog;
      console.info = originalConsoleInfo;
    }
  }

  return exitCode;
}
