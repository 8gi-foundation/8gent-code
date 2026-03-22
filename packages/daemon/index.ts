/**
 * Eight Daemon - Always-on agent process.
 *
 * Starts WebSocket gateway, heartbeat, cron scheduler, and event bus.
 * Logs to ~/.8gent/daemon.log. Graceful shutdown on SIGTERM/SIGINT.
 */

import { existsSync, appendFileSync, mkdirSync } from "fs";
import { bus } from "./events";
import { startGateway } from "./gateway";
import { startHeartbeat, stopHeartbeat } from "./heartbeat";
import { startCron, stopCron } from "./cron";
import { AgentPool, loadPoolConfig } from "./agent-pool";

const PORT = 18789;
const LOG_PATH = `${process.env.HOME}/.8gent/daemon.log`;
const CONFIG_PATH = `${process.env.HOME}/.8gent/config.json`;

interface DaemonConfig {
  port: number;
  authToken: string | null;
  heartbeatIntervalMs: number;
  heartbeatEnabled: boolean;
}

async function loadConfig(): Promise<DaemonConfig> {
  const defaults: DaemonConfig = {
    port: PORT,
    authToken: null,
    heartbeatIntervalMs: 30 * 60 * 1000,
    heartbeatEnabled: true,
  };

  try {
    const file = Bun.file(CONFIG_PATH);
    if (!(await file.exists())) return defaults;
    const raw = await file.json();
    const daemon = raw?.daemon || {};
    return {
      port: daemon.port ?? defaults.port,
      authToken: daemon.authToken ?? defaults.authToken,
      heartbeatIntervalMs: daemon.heartbeatIntervalMs ?? defaults.heartbeatIntervalMs,
      heartbeatEnabled: daemon.heartbeatEnabled ?? defaults.heartbeatEnabled,
    };
  } catch {
    return defaults;
  }
}

function setupLogging(): void {
  const logDir = `${process.env.HOME}/.8gent`;
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  // Subscribe to all events and append to log file
  const events = [
    "tool:start", "tool:result", "agent:thinking", "agent:stream",
    "agent:error", "memory:saved", "approval:required", "session:start", "session:end",
  ] as const;

  for (const event of events) {
    bus.on(event, (payload: any) => {
      const line = `${new Date().toISOString()} [${event}] ${JSON.stringify(payload)}\n`;
      try {
        appendFileSync(LOG_PATH, line);
      } catch {
        // Log dir may not exist on first write
      }
    });
  }
}

const STATE_PATH = `${process.env.HOME}/.8gent/daemon-state.json`;

let server: ReturnType<typeof startGateway> | null = null;
let pool: AgentPool | null = null;

/** Save active session IDs to disk so they can be resumed after restart */
function saveState(): void {
  if (!pool) return;
  try {
    const state = {
      savedAt: new Date().toISOString(),
      sessions: pool.getActiveSessions(),
    };
    const data = JSON.stringify(state, null, 2);
    // Sync write - we're shutting down, can't afford async
    require("fs").writeFileSync(STATE_PATH, data);
    console.log(`[daemon] saved ${state.sessions.length} session(s) to disk`);
  } catch (err) {
    console.error("[daemon] failed to save state:", err);
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[daemon] received ${signal}, shutting down...`);
  saveState();
  stopHeartbeat();
  stopCron();
  if (server) {
    server.stop();
    server = null;
  }
  pool = null;
  bus.clear();
  console.log("[daemon] stopped");
  process.exit(0);
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const poolConfig = await loadPoolConfig();

  console.log(`[daemon] Eight Daemon starting...`);
  console.log(`[daemon] port=${config.port} heartbeat=${config.heartbeatEnabled} auth=${config.authToken ? "enabled" : "disabled"}`);
  console.log(`[daemon] model=${poolConfig.model || "qwen3.5:14b"} runtime=${poolConfig.runtime || "ollama"}`);

  // Setup log file writer
  setupLogging();

  // Create the agent pool - manages Agent instances per session
  pool = new AgentPool(poolConfig);

  // Start WebSocket gateway with agent pool
  server = startGateway({
    port: config.port,
    authToken: config.authToken,
    pool,
  });

  // Start heartbeat
  startHeartbeat({
    intervalMs: config.heartbeatIntervalMs,
    enabled: config.heartbeatEnabled,
  });

  // Start cron scheduler
  await startCron();

  console.log(`[daemon] ready - ws://localhost:${config.port}`);
  console.log(`[daemon] health check: http://localhost:${config.port}/health`);

  // Graceful shutdown
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[daemon] fatal:", err);
    process.exit(1);
  });
}
