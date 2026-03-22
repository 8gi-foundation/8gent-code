/**
 * AgentPool - Manages Agent instances for the daemon.
 *
 * Creates one Agent per session. Routes messages from the gateway
 * to agent.chat() and bridges agent events back to the daemon EventBus.
 */

import { Agent } from "../eight/agent";
import type { AgentConfig, AgentEventCallbacks } from "../eight/types";
import { bus } from "./events";

export interface PoolConfig {
  /** Default model to use (e.g. "qwen3.5:14b") */
  model: string;
  /** Runtime provider */
  runtime: "ollama" | "lmstudio" | "openrouter";
  /** Working directory for agent file operations */
  workingDirectory: string;
  /** OpenRouter API key (if runtime is openrouter) */
  apiKey?: string;
  /** Max tool-call turns per chat() invocation */
  maxTurns?: number;
}

interface SessionEntry {
  agent: Agent;
  channel: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  busy: boolean; // true while agent.chat() is in flight
}

const DEFAULT_MODEL = "qwen3.5:14b";
const DEFAULT_RUNTIME = "ollama" as const;
const MAX_SESSIONS = 10;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class AgentPool {
  private sessions = new Map<string, SessionEntry>();
  private config: PoolConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<PoolConfig> = {}) {
    this.config = {
      model: config.model || DEFAULT_MODEL,
      runtime: config.runtime || DEFAULT_RUNTIME,
      workingDirectory: config.workingDirectory || process.cwd(),
      apiKey: config.apiKey,
      maxTurns: config.maxTurns || 50,
    };

    // Clean up idle sessions every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 5 * 60 * 1000);
  }

  /** Remove sessions that have been idle for longer than IDLE_TIMEOUT_MS */
  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (!entry.busy && (now - entry.lastActiveAt) > IDLE_TIMEOUT_MS) {
        console.log(`[agent-pool] evicting idle session ${id} (idle ${Math.round((now - entry.lastActiveAt) / 60_000)}m)`);
        this.sessions.delete(id);
        bus.emit("session:end", { sessionId: id, reason: "idle-timeout" });
      }
    }
  }

  /** Create a new session with its own Agent instance */
  createSession(sessionId: string, channel: string): void {
    if (this.sessions.size >= MAX_SESSIONS) {
      // Evict oldest idle session
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, entry] of this.sessions) {
        if (!entry.busy && entry.createdAt < oldestTime) {
          oldestTime = entry.createdAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.destroySession(oldestId);
      }
    }

    const events = this.buildEventCallbacks(sessionId);

    const agentConfig: AgentConfig = {
      model: this.config.model,
      runtime: this.config.runtime,
      workingDirectory: this.config.workingDirectory,
      apiKey: this.config.apiKey,
      maxTurns: this.config.maxTurns,
      events,
    };

    const agent = new Agent(agentConfig);

    const now = Date.now();
    this.sessions.set(sessionId, {
      agent,
      channel,
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
      busy: false,
    });

    console.log(`[agent-pool] created session ${sessionId} (channel=${channel}, model=${this.config.model})`);
  }

  /** Send a message to an agent and stream the response via the event bus */
  async chat(sessionId: string, text: string): Promise<string> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      bus.emit("agent:error", { sessionId, error: "session not found" });
      return "[error] session not found";
    }

    if (entry.busy) {
      bus.emit("agent:error", { sessionId, error: "agent is busy processing another message" });
      return "[error] agent is busy";
    }

    entry.busy = true;
    entry.messageCount++;
    entry.lastActiveAt = Date.now();
    bus.emit("agent:thinking", { sessionId });

    try {
      const response = await entry.agent.chat(text);

      // Emit the full final response (distinct from stream chunks)
      bus.emit("agent:stream", { sessionId, chunk: response, final: true });

      return response;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      bus.emit("agent:error", { sessionId, error: errorMsg });
      return `[error] ${errorMsg}`;
    } finally {
      entry.busy = false;
    }
  }

  /** Destroy a session and its Agent */
  destroySession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    this.sessions.delete(sessionId);
    console.log(`[agent-pool] destroyed session ${sessionId}`);
  }

  /** Check if a session exists */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Get session info */
  getSessionInfo(sessionId: string): { channel: string; messageCount: number; busy: boolean } | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return {
      channel: entry.channel,
      messageCount: entry.messageCount,
      busy: entry.busy,
    };
  }

  /** Get count of active sessions */
  get size(): number {
    return this.sessions.size;
  }

  /** Return metadata for all active sessions (for state persistence) */
  getActiveSessions(): Array<{ sessionId: string; channel: string; messageCount: number; createdAt: number }> {
    const result: Array<{ sessionId: string; channel: string; messageCount: number; createdAt: number }> = [];
    for (const [id, entry] of this.sessions) {
      result.push({
        sessionId: id,
        channel: entry.channel,
        messageCount: entry.messageCount,
        createdAt: entry.createdAt,
      });
    }
    return result;
  }

  /** Build event callbacks that bridge Agent events to the daemon EventBus */
  private buildEventCallbacks(sessionId: string): AgentEventCallbacks {
    return {
      onToolStart: (event) => {
        bus.emit("tool:start", {
          sessionId,
          tool: event.toolName,
          input: event.args,
        });
      },

      onToolEnd: (event) => {
        bus.emit("tool:result", {
          sessionId,
          tool: event.toolName,
          output: event.resultPreview || "",
          durationMs: event.durationMs,
        });
      },

      onStepFinish: (event) => {
        // Emit the assistant's text response as a stream chunk
        if (event.text) {
          bus.emit("agent:stream", {
            sessionId,
            chunk: event.text,
          });
        }
      },

      onEvidence: (event) => {
        // Evidence is a validation signal - emit as a memory event
        bus.emit("memory:saved", {
          sessionId,
          key: `evidence:${event.type || "validation"}`,
        });
      },
    };
  }
}

/** Load pool config from env vars, then ~/.8gent/config.json as fallback */
export async function loadPoolConfig(): Promise<Partial<PoolConfig>> {
  let fileConfig: Record<string, any> = {};
  try {
    const configPath = `${process.env.HOME}/.8gent/config.json`;
    const file = Bun.file(configPath);
    if (await file.exists()) {
      fileConfig = await file.json();
    }
  } catch {
    // No config file - use env vars and defaults
  }

  return {
    model: process.env.DEFAULT_MODEL || fileConfig?.model || fileConfig?.defaultModel,
    runtime: (process.env.DEFAULT_RUNTIME || fileConfig?.runtime || fileConfig?.provider) as PoolConfig["runtime"],
    workingDirectory: fileConfig?.workingDirectory || process.cwd(),
    apiKey: process.env.OPENROUTER_API_KEY || fileConfig?.apiKey,
    maxTurns: fileConfig?.maxTurns,
  };
}
