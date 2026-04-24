/**
 * External Agent Adapters
 *
 * Standard interface for spawning and monitoring external coding agents.
 * The vessel acts as conductor - it doesn't care which agent does the work,
 * just that the interface is consistent.
 *
 * Supported agents:
 * - Claude Code CLI (claude)
 * - OpenAI Codex CLI (codex)
 * - OpenCode CLI (opencode)
 * - Generic CLI (any command-line tool)
 *
 * Each adapter:
 * 1. Checks if the agent is available on the system
 * 2. Spawns it with a task
 * 3. Streams output
 * 4. Collects results
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ───────────────────────────────────────────────────────

export interface AgentAdapter {
  /** Unique adapter name */
  name: string;
  /** Human-readable label */
  label: string;
  /** Check if the agent CLI is installed and available */
  isAvailable(): Promise<boolean>;
  /** Spawn the agent with a task, return a running handle */
  spawn(task: string, options?: AgentSpawnOptions): AgentHandle;
}

export interface AgentSpawnOptions {
  cwd?: string;
  timeout?: number; // ms
  model?: string;
  env?: Record<string, string>;
  /** Auto-approve all prompts (non-interactive) */
  autoApprove?: boolean;
}

export interface AgentHandle {
  id: string;
  adapter: string;
  task: string;
  process: ChildProcess;
  startedAt: Date;
  /** Promise that resolves when the agent completes */
  result: Promise<AgentResult>;
  /** Kill the agent */
  kill(): void;
}

export interface AgentResult {
  adapter: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// ── Helpers ─────────────────────────────────────────────────────

let handleCounter = 0;

function nextId(prefix: string): string {
  return `${prefix}-${++handleCounter}`;
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    return exit === 0;
  } catch {
    return false;
  }
}

function spawnWithTimeout(
  cmd: string,
  args: string[],
  options: AgentSpawnOptions,
  adapterName: string,
): AgentHandle {
  const id = nextId(adapterName);
  const cwd = options.cwd || process.cwd();
  const timeout = options.timeout || 5 * 60 * 1000;
  const startedAt = new Date();

  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
  }, timeout);

  const result = new Promise<AgentResult>((resolve) => {
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        adapter: adapterName,
        exitCode: code,
        stdout: stdout.slice(0, 50000), // Cap at 50KB
        stderr: stderr.slice(0, 10000),
        timedOut,
        durationMs: Date.now() - startedAt.getTime(),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        adapter: adapterName,
        exitCode: null,
        stdout,
        stderr: `Spawn error: ${err.message}\n${stderr}`,
        timedOut: false,
        durationMs: Date.now() - startedAt.getTime(),
      });
    });
  });

  return {
    id,
    adapter: adapterName,
    task: args.join(" "),
    process: proc,
    startedAt,
    result,
    kill: () => { clearTimeout(timer); proc.kill(); },
  };
}

// ── Claude Code Adapter ─────────────────────────────────────────

export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  label: "Claude Code CLI",

  async isAvailable(): Promise<boolean> {
    return commandExists("claude");
  },

  spawn(task: string, options: AgentSpawnOptions = {}): AgentHandle {
    const args = ["--print"];
    if (options.autoApprove) args.push("--dangerously-skip-permissions");
    if (options.model) args.push("--model", options.model);
    args.push(task);

    return spawnWithTimeout("claude", args, options, "claude-code");
  },
};

// ── OpenAI Codex Adapter ────────────────────────────────────────

export const codexAdapter: AgentAdapter = {
  name: "codex",
  label: "OpenAI Codex CLI",

  async isAvailable(): Promise<boolean> {
    return commandExists("codex");
  },

  spawn(task: string, options: AgentSpawnOptions = {}): AgentHandle {
    const args: string[] = [];
    if (options.autoApprove) args.push("--approval-mode", "full-auto");
    if (options.model) args.push("--model", options.model);
    args.push(task);

    return spawnWithTimeout("codex", args, options, "codex");
  },
};

// ── OpenCode Adapter ────────────────────────────────────────────

export const openCodeAdapter: AgentAdapter = {
  name: "opencode",
  label: "OpenCode CLI",

  async isAvailable(): Promise<boolean> {
    return commandExists("opencode");
  },

  spawn(task: string, options: AgentSpawnOptions = {}): AgentHandle {
    const args = ["--non-interactive", task];
    return spawnWithTimeout("opencode", args, options, "opencode");
  },
};

// ── 8gent Self Adapter ──────────────────────────────────────────

export const eightAdapter: AgentAdapter = {
  name: "8gent",
  label: "8gent Code",

  async isAvailable(): Promise<boolean> {
    // Always available - we are 8gent
    return true;
  },

  spawn(task: string, options: AgentSpawnOptions = {}): AgentHandle {
    const args = ["run", "bin/8gent.ts", "chat", task, "--json"];
    if (options.autoApprove) args.push("--yes");
    if (options.model) args.push(`--model=${options.model}`);

    return spawnWithTimeout("bun", args, {
      ...options,
      cwd: options.cwd || join(homedir(), ".8gent", "8gent-code"),
    }, "8gent");
  },
};

// ── Registry ────────────────────────────────────────────────────

const ADAPTERS: AgentAdapter[] = [
  eightAdapter,
  claudeCodeAdapter,
  codexAdapter,
  openCodeAdapter,
];

/**
 * Get all registered agent adapters.
 */
export function getAdapters(): AgentAdapter[] {
  return [...ADAPTERS];
}

/**
 * Get a specific adapter by name.
 */
export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.name === name) || null;
}

/**
 * Discover which external agents are available on this system.
 */
export async function discoverAgents(): Promise<Array<{ name: string; label: string; available: boolean }>> {
  const results = await Promise.all(
    ADAPTERS.map(async (a) => ({
      name: a.name,
      label: a.label,
      available: await a.isAvailable(),
    })),
  );
  return results;
}

/**
 * Spawn the best available agent for a task.
 * Preference order: 8gent (self) > Claude Code > Codex > OpenCode
 */
export async function spawnBestAgent(
  task: string,
  options: AgentSpawnOptions & { prefer?: string } = {},
): Promise<AgentHandle | null> {
  // If a specific adapter is preferred, try it first
  if (options.prefer) {
    const preferred = getAdapter(options.prefer);
    if (preferred && await preferred.isAvailable()) {
      return preferred.spawn(task, options);
    }
  }

  // Try each adapter in order
  for (const adapter of ADAPTERS) {
    if (await adapter.isAvailable()) {
      return adapter.spawn(task, options);
    }
  }

  return null;
}
