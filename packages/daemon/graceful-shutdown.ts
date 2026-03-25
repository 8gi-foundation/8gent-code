/**
 * Graceful Shutdown - Handles SIGTERM/SIGINT for the Eight daemon.
 *
 * Sequence: save state -> notify clients -> close sessions -> flush logs -> exit.
 * Timeout: if shutdown takes longer than 10s, force exit.
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { bus } from "./events";
import type { AgentPool } from "./agent-pool";
import { stopHeartbeat } from "./heartbeat";
import { stopCron } from "./cron";

export interface ShutdownDeps {
  pool: AgentPool | null;
  server: { stop: () => void } | null;
  statePath: string;
  logPath: string;
}

const SHUTDOWN_TIMEOUT_MS = 10_000;
let shutdownInProgress = false;

/** Write a timestamped line to the daemon log (sync - safe during shutdown). */
function logSync(logPath: string, message: string): void {
  const line = `${new Date().toISOString()} [shutdown] ${message}\n`;
  try {
    const dir = logPath.substring(0, logPath.lastIndexOf("/"));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, line);
  } catch {
    // Best effort - log dir may be gone
  }
  console.log(`[shutdown] ${message}`);
}

/** Persist active session metadata so they can be resumed after restart. */
function saveState(pool: AgentPool, statePath: string): number {
  const sessions = pool.getActiveSessions();
  const state = {
    savedAt: new Date().toISOString(),
    reason: "graceful-shutdown",
    sessions,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return sessions.length;
}

/** Broadcast a shutdown notice to all WebSocket clients via the event bus. */
function notifyClients(pool: AgentPool): void {
  const sessions = pool.getActiveSessions();
  for (const s of sessions) {
    bus.emit("session:end", {
      sessionId: s.sessionId,
      reason: "daemon-shutdown",
    });
  }
}

/** Close all sessions in the agent pool. */
function closeSessions(pool: AgentPool): void {
  const sessions = pool.getActiveSessions();
  for (const s of sessions) {
    pool.destroySession(s.sessionId);
  }
}

/**
 * Run the full graceful shutdown sequence.
 *
 * 1. Save pool state to disk
 * 2. Notify connected clients of impending shutdown
 * 3. Destroy all agent sessions
 * 4. Stop heartbeat and cron
 * 5. Stop WebSocket server
 * 6. Flush final log entry and clear event bus
 * 7. Exit process
 */
export async function gracefulShutdown(
  signal: string,
  deps: ShutdownDeps
): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  const { pool, server, statePath, logPath } = deps;

  // Hard timeout - force exit if cleanup stalls
  const forceTimer = setTimeout(() => {
    logSync(logPath, `force exit after ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  logSync(logPath, `received ${signal} - starting graceful shutdown`);

  // 1. Save state
  if (pool) {
    try {
      const count = saveState(pool, statePath);
      logSync(logPath, `saved ${count} session(s) to ${statePath}`);
    } catch (err) {
      logSync(logPath, `state save failed: ${err}`);
    }

    // 2. Notify clients
    try {
      notifyClients(pool);
      logSync(logPath, "notified connected clients");
    } catch (err) {
      logSync(logPath, `client notification failed: ${err}`);
    }

    // 3. Close sessions
    try {
      closeSessions(pool);
      logSync(logPath, "all sessions closed");
    } catch (err) {
      logSync(logPath, `session cleanup failed: ${err}`);
    }
  }

  // 4. Stop background services
  stopHeartbeat();
  stopCron();
  logSync(logPath, "heartbeat and cron stopped");

  // 5. Stop server
  if (server) {
    try {
      server.stop();
      logSync(logPath, "websocket server stopped");
    } catch (err) {
      logSync(logPath, `server stop failed: ${err}`);
    }
  }

  // 6. Flush and clear
  logSync(logPath, "shutdown complete");
  bus.clear();

  // 7. Exit
  clearTimeout(forceTimer);
  process.exit(0);
}

/**
 * Register SIGTERM and SIGINT handlers for graceful shutdown.
 * Call this once during daemon startup.
 */
export function registerShutdownHandlers(deps: ShutdownDeps): void {
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM", deps));
  process.on("SIGINT", () => gracefulShutdown("SIGINT", deps));
}
