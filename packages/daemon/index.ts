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
import { startCron, stopCron, getJobs, addJob } from "./cron";
import { AgentPool, loadPoolConfig } from "./agent-pool";
import { resolveBestFreeModel } from "./model-resolver";
import { getDataDir } from "./data-dir";
import { VesselMesh, type TaskPayload, type TaskResult } from "../orchestration/vessel-mesh";

const PORT = 18789;
const DATA_DIR = getDataDir();
const LOG_PATH = `${DATA_DIR}/daemon.log`;
const CONFIG_PATH = `${DATA_DIR}/config.json`;
const DEFAULT_MODEL = "qwen3.5:14b";

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
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
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

const STATE_PATH = `${DATA_DIR}/daemon-state.json`;

let server: ReturnType<typeof startGateway> | null = null;
let pool: AgentPool | null = null;
let mesh: VesselMesh | null = null;

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
  if (mesh) {
    await mesh.stop().catch(() => {});
    mesh = null;
  }
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

  // Auto-resolve best free model if requested
  const modelValue = poolConfig.model || DEFAULT_MODEL;
  if (modelValue === "auto:free" || modelValue === "auto") {
    console.log(`[daemon] model=auto:free - resolving best free model from OpenRouter...`);
    const resolved = await resolveBestFreeModel(poolConfig.apiKey);
    poolConfig.model = resolved.id;
    poolConfig.runtime = "openrouter";
    console.log(`[daemon] selected: ${resolved.id} (ctx: ${resolved.contextLength}, free: ${resolved.free})`);
  } else {
    console.log(`[daemon] model=${modelValue} runtime=${poolConfig.runtime || "ollama"}`);
  }

  // Load vessel context for self-awareness
  try {
    const vesselContextPath = `${import.meta.dir}/VESSEL-CONTEXT.md`;
    const vesselFile = Bun.file(vesselContextPath);
    if (await vesselFile.exists()) {
      process.env.EIGHT_VESSEL_CONTEXT = await vesselFile.text();
      console.log("[daemon] vessel context loaded (self-awareness active)");
    }
  } catch {}

  // Setup log file writer
  setupLogging();

  // Create the agent pool - manages Agent instances per session
  pool = new AgentPool(poolConfig);

  // Lotus-Class Compute — set up the mesh BEFORE the gateway so the gateway
  // can route incoming mesh-protocol messages to mesh.handleIncomingMessage().
  // Mesh start (registry + heartbeat) still happens later, but the handler
  // and onTask wiring need to exist before we accept any peer connections.
  if (process.env.GROVE_ENABLED === "1") {
    const vesselId = process.env.VESSEL_ID || `local-${require("os").hostname()}`;
    const vesselUrl = process.env.VESSEL_URL || `ws://localhost:${config.port}`;
    const vesselRegion = process.env.VESSEL_REGION || "local";
    const vesselName = process.env.VESSEL_NAME || vesselId;

    mesh = new VesselMesh({
      id: vesselId,
      name: vesselName,
      url: vesselUrl,
      ownerId: process.env.VESSEL_OWNER || "8gi-foundation",
      capabilities: ["code", "inference", poolConfig.runtime || "ollama"],
      model: poolConfig.model || DEFAULT_MODEL,
      region: vesselRegion,
      startedAt: Date.now(),
      activeSessions: 0,
      maxSessions: 10,
    });

    mesh.onTask(async (task: TaskPayload, from: string): Promise<TaskResult> => {
      const start = Date.now();
      if (!pool) {
        return {
          status: "failed",
          output: "",
          durationMs: Date.now() - start,
          error: "agent pool unavailable",
        };
      }
      try {
        const sessionId = `grove_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        pool.createSession(sessionId, "api");
        const output = await pool.chat(sessionId, task.prompt);
        pool.destroySession(sessionId);
        return {
          status: "completed",
          output: typeof output === "string" ? output : JSON.stringify(output),
          durationMs: Date.now() - start,
        };
      } catch (err) {
        return {
          status: "failed",
          output: "",
          durationMs: Date.now() - start,
          error: String(err),
        };
      }
    });
  }

  // Start WebSocket gateway with agent pool (and mesh, if grove is enabled)
  server = startGateway({
    port: config.port,
    authToken: config.authToken,
    pool,
    mesh,
  });

  // Start heartbeat
  startHeartbeat({
    intervalMs: config.heartbeatIntervalMs,
    enabled: config.heartbeatEnabled,
  });

  // Start cron scheduler
  await startCron();

  // Auto-register daily CEO summary if not present
  const existingJobs = getJobs();
  if (!existingJobs.find((j: any) => j.id === "daily-ceo-summary")) {
    addJob({
      id: "daily-ceo-summary",
      name: "CEO Daily Summary",
      expression: "0 9 * * *",
      type: "agent-prompt",
      payload: "Generate a brief daily summary: list completed tasks, open PRs, and any pending work from the task registry at ~/.8gent/tasks.json",
      enabled: true,
      lastRun: null,
      nextRun: null,
      recurring: true,
    });
    console.log("[daemon] registered daily CEO summary cron (9 AM)");
  }

  console.log(`[daemon] ready - ws://localhost:${config.port}`);
  console.log(`[daemon] health check: http://localhost:${config.port}/health`);

  // Start mesh registry + discovery + heartbeat (mesh handler is already
  // wired into the gateway above).
  if (mesh) {
    await mesh.start();
    console.log(`[daemon] grove mesh started - vesselId=${mesh.getInfo().id} region=${mesh.getInfo().region}`);
  }

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
