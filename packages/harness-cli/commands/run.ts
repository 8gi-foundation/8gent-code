/**
 * harness-cli: run command
 *
 * Runs a headless 8gent session and captures the full result.
 * Outputs session ID + summary so callers can inspect or validate.
 */

import { Agent } from "../../eight/agent.js";
import type { AgentConfig } from "../../eight/types.js";
import { getPermissionManager } from "../../permissions/index.js";

interface RunOptions {
  prompt: string;
  model: string;
  runtime: "ollama" | "lmstudio" | "openrouter";
  maxSteps: number;
  workdir: string;
  timeout: number;
  json: boolean;
  apiKey?: string;
}

function parseArgs(args: string[]): RunOptions {
  const opts: RunOptions = {
    prompt: "",
    model: process.env.EIGHGENT_MODEL || "glm-4.7-flash:latest",
    runtime: (process.env.EIGHGENT_RUNTIME as RunOptions["runtime"]) || "ollama",
    maxSteps: 30,
    workdir: process.cwd(),
    timeout: 300_000,
    json: false,
    apiKey: process.env.OPENROUTER_API_KEY,
  };

  const promptParts: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--model":
        opts.model = args[++i];
        break;
      case "--runtime":
        opts.runtime = args[++i] as RunOptions["runtime"];
        break;
      case "--max-steps":
        opts.maxSteps = parseInt(args[++i], 10);
        break;
      case "--workdir":
        opts.workdir = args[++i];
        break;
      case "--timeout":
        opts.timeout = parseInt(args[++i], 10);
        break;
      case "--json":
        opts.json = true;
        break;
      case "--api-key":
        opts.apiKey = args[++i];
        break;
      default:
        promptParts.push(arg);
    }
    i++;
  }

  opts.prompt = promptParts.join(" ");
  return opts;
}

export async function run(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (!opts.prompt) {
    console.error("Usage: harness-cli run <prompt> [options]");
    console.error('Example: harness-cli run "Write fibonacci in fib.js"');
    process.exit(1);
  }

  // Enable infinite mode — headless runs bypass permission prompts
  const permManager = getPermissionManager();
  permManager.enableInfiniteMode();

  const config: AgentConfig = {
    model: opts.model,
    runtime: opts.runtime,
    workingDirectory: opts.workdir,
    maxTurns: opts.maxSteps,
    apiKey: opts.apiKey,
  };

  const agent = new Agent(config);

  // Check provider health
  if (!(await agent.isReady())) {
    const msg = `Provider "${opts.runtime}" is not available. Is ${opts.runtime} running?`;
    if (opts.json) {
      console.log(JSON.stringify({ error: msg, success: false }));
    } else {
      console.error(`[ERROR] ${msg}`);
    }
    process.exit(1);
  }

  const sessionPath = agent.getSessionFilePath();
  const sessionId = sessionPath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";

  if (!opts.json) {
    console.log(`[harness] Session: ${sessionId}`);
    console.log(`[harness] Model: ${opts.model} (${opts.runtime})`);
    console.log(`[harness] Working dir: ${opts.workdir}`);
    console.log(`[harness] Max steps: ${opts.maxSteps}`);
    console.log(`[harness] Prompt: ${opts.prompt}`);
    console.log(`[harness] Session file: ${sessionPath}`);
    console.log(`[harness] ─────────────────────────────────`);
  }

  const startTime = Date.now();

  // Run with timeout
  let result: string;
  let success = true;
  let error: string | null = null;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${opts.timeout}ms`)), opts.timeout);
    });

    result = await Promise.race([
      agent.chat(opts.prompt),
      timeoutPromise,
    ]);
  } catch (err) {
    success = false;
    error = err instanceof Error ? err.message : String(err);
    result = "";
  }

  const durationMs = Date.now() - startTime;

  // Cleanup
  try {
    await agent.cleanup();
  } catch {
    // already closed
  }

  if (opts.json) {
    console.log(JSON.stringify({
      success,
      sessionId,
      sessionPath,
      model: opts.model,
      runtime: opts.runtime,
      prompt: opts.prompt,
      result: result.slice(0, 5000),
      error,
      durationMs,
    }, null, 2));
  } else {
    console.log(`[harness] ─────────────────────────────────`);
    if (success) {
      console.log(`[harness] SUCCESS in ${(durationMs / 1000).toFixed(1)}s`);
      console.log(`[harness] Result (first 2000 chars):`);
      console.log(result.slice(0, 2000));
    } else {
      console.log(`[harness] FAILED in ${(durationMs / 1000).toFixed(1)}s`);
      console.log(`[harness] Error: ${error}`);
    }
    console.log(`\n[harness] Session ID: ${sessionId}`);
    console.log(`[harness] Inspect: bun run packages/harness-cli/index.ts inspect ${sessionId}`);
  }
}
