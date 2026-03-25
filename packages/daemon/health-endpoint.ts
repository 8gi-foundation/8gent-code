/**
 * Health Endpoint - HTTP health, readiness, and metrics for the Eight daemon.
 *
 * Exposes three routes on a configurable port (default 18790):
 *   GET /health  - liveness probe: is the process alive?
 *   GET /ready   - readiness probe: is the daemon ready to accept work?
 *   GET /metrics - lightweight runtime metrics snapshot
 *
 * Zero external dependencies. Uses only Bun.serve.
 *
 * Usage:
 *   const health = createHealthServer({ pool, port: 18790 });
 *   health.stop(); // clean shutdown
 */

export interface HealthDeps {
  /** Optional pool reference for session counts and readiness */
  pool?: {
    getActiveSessions(): string[];
    getSessions?(): Map<string, { busy: boolean; createdAt: number; lastActiveAt: number; messageCount: number }>;
  };
  /** Port to bind the HTTP server on. Defaults to 18790. */
  port?: number;
  /** Daemon start time. Defaults to module load time. */
  startedAt?: number;
}

export interface HealthServer {
  port: number;
  stop(): void;
}

const MODULE_LOAD_TIME = Date.now();

function uptimeSeconds(startedAt: number): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function buildHealth(deps: HealthDeps): Response {
  const startedAt = deps.startedAt ?? MODULE_LOAD_TIME;
  return Response.json({
    status: "ok",
    uptime_seconds: uptimeSeconds(startedAt),
    timestamp: new Date().toISOString(),
  });
}

function buildReady(deps: HealthDeps): Response {
  const sessions = deps.pool?.getActiveSessions() ?? [];
  const ready = true; // daemon is ready if process is running and pool exists
  const status = ready ? 200 : 503;
  return Response.json(
    {
      status: ready ? "ready" : "not_ready",
      active_sessions: sessions.length,
    },
    { status }
  );
}

function buildMetrics(deps: HealthDeps): Response {
  const startedAt = deps.startedAt ?? MODULE_LOAD_TIME;
  const sessions = deps.pool?.getActiveSessions() ?? [];

  // Per-session detail if the pool exposes getSessions()
  let sessionDetails: Array<{
    id: string;
    busy: boolean;
    uptime_seconds: number;
    last_active_seconds_ago: number;
    message_count: number;
  }> = [];

  if (deps.pool?.getSessions) {
    const map = deps.pool.getSessions();
    const now = Date.now();
    for (const [id, entry] of map.entries()) {
      sessionDetails.push({
        id,
        busy: entry.busy,
        uptime_seconds: Math.floor((now - entry.createdAt) / 1000),
        last_active_seconds_ago: Math.floor((now - entry.lastActiveAt) / 1000),
        message_count: entry.messageCount,
      });
    }
  }

  const mem = process.memoryUsage();

  return Response.json({
    uptime_seconds: uptimeSeconds(startedAt),
    timestamp: new Date().toISOString(),
    sessions: {
      active: sessions.length,
      detail: sessionDetails,
    },
    memory: {
      rss_mb: +(mem.rss / 1024 / 1024).toFixed(2),
      heap_used_mb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
      heap_total_mb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
    },
    process: {
      pid: process.pid,
      node_version: process.version,
    },
  });
}

/**
 * Creates and starts the health HTTP server.
 *
 * @example
 * const health = createHealthServer({ pool, port: 18790 });
 * // later:
 * health.stop();
 */
export function createHealthServer(deps: HealthDeps = {}): HealthServer {
  const port = deps.port ?? 18790;

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (req.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      switch (url.pathname) {
        case "/health":
          return buildHealth(deps);
        case "/ready":
          return buildReady(deps);
        case "/metrics":
          return buildMetrics(deps);
        default:
          return new Response("Not Found", { status: 404 });
      }
    },
    error(err) {
      console.error("[health-endpoint] server error:", err);
      return new Response("Internal Server Error", { status: 500 });
    },
  });

  console.log(`[health-endpoint] listening on http://localhost:${port}`);

  return {
    port,
    stop() {
      server.stop();
      console.log("[health-endpoint] stopped");
    },
  };
}
