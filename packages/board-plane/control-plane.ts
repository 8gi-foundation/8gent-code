/**
 * Control Plane - Main entry point for the board plane system.
 *
 * Wires together: TaskQueue, DiscordGateway (per bot), DiscordRest,
 * TaskRouter, and a WebSocket server for vessel connections.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 */

import type { ControlPlaneConfig, PlaneToVessel, VesselToPlane, BoardTask } from "./types";
import { TaskQueue } from "./task-queue";
import { DiscordGateway } from "./discord-gateway";
import { DiscordRest } from "./discord-rest";
import { TaskRouter, RateLimiter } from "./task-router";
import { MemoryBridge } from "./memory-bridge";
import { AuditLog } from "./audit-log";
import { validateResponse, sanitizeResponse } from "./content-policy";
import { VesselHealthMonitor } from "./vessel-health";

interface VesselConnection {
  ws: any;
  memberCode: string;
  vesselId: string;
  authenticated: boolean;
  lastHeartbeat: number;
}

export async function startControlPlane(config: ControlPlaneConfig): Promise<void> {
  console.log("[control-plane] starting...");

  // 1. Open databases and monitors
  const taskQueue = new TaskQueue(config.dbPath);
  const dbDir = config.dbPath.replace(/[^/]+$/, "");
  const memory = new MemoryBridge(`${dbDir}board-memory.db`);
  const audit = new AuditLog(`${dbDir}board-audit.db`);
  const healthMonitor = new VesselHealthMonitor((msg) => {
    console.warn(`[health-alert] ${msg}`);
  });

  // 2. Recover stale tasks from previous crash
  const recovered = taskQueue.recoverStaleTasks(config.staleTaskMaxAgeMs);
  if (recovered > 0) console.log(`[control-plane] recovered ${recovered} stale tasks`);

  // 3. Build member map and token map
  const memberMap = new Map(config.members.map((m) => [m.code, m]));
  const tokenMap = new Map(config.members.map((m) => [m.code, m.discordBotToken]));

  // 4. Create REST client and router
  const rest = new DiscordRest(tokenMap);
  const rateLimiter = new RateLimiter(config.rateLimitMs);
  const router = new TaskRouter(memberMap, taskQueue, rateLimiter);

  // 5. Connect Discord gateways (one per bot)
  const gateways: DiscordGateway[] = [];
  for (const member of config.members) {
    if (!member.discordBotToken) {
      console.log(`[control-plane] skipping ${member.code} - no token`);
      continue;
    }
    const gw = new DiscordGateway(
      member.discordBotToken,
      member.code,
      (msg) => router.handleMessage(member.code, msg),
      (botUserId) => {
        member.discordBotId = botUserId;
        router.registerBotId(member.code, botUserId);
      },
    );
    gw.connect();
    gateways.push(gw);
  }

  // 6. Vessel WebSocket server
  const vessels = new Map<any, VesselConnection>();
  let nextVesselId = 0;

  function sendToVessel(ws: any, msg: PlaneToVessel): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* disconnected */ }
  }

  const vesselServer = Bun.serve({
    port: config.vesselPort,
    hostname: "0.0.0.0",
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          tasks: taskQueue.getStats(),
          vessels: healthMonitor.getSummary(),
          memory: memory.getStats(),
          audit: audit.getStats(),
        });
      }
      return new Response("Board Control Plane", { status: 200 });
    },
    websocket: {
      open(ws) {
        const id = `v_${nextVesselId++}`;
        vessels.set(ws, { ws, memberCode: "", vesselId: id, authenticated: false, lastHeartbeat: Date.now() });
        console.log(`[control-plane] vessel ${id} connected`);
        audit.log("vessel:connected", { vesselId: id });
      },
      message(ws, raw) {
        const conn = vessels.get(ws);
        if (!conn) return;
        let msg: VesselToPlane;
        try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as ArrayBuffer)); } catch { return; }

        if (!conn.authenticated) {
          if (msg.type === "auth" && msg.token === config.vesselAuthToken) {
            conn.authenticated = true;
            conn.memberCode = msg.memberCode;
            healthMonitor.register(conn.vesselId, msg.memberCode);
            sendToVessel(ws, { type: "auth:ok", vesselId: conn.vesselId });
            console.log(`[control-plane] vessel ${conn.vesselId} authenticated as ${msg.memberCode}`);
          } else {
            sendToVessel(ws, { type: "auth:fail", reason: "invalid token" });
            audit.log("vessel:auth_failed", { vesselId: conn.vesselId });
          }
          return;
        }

        switch (msg.type) {
          case "ready": {
            // Vessel is ready - try to assign a pending task
            const task = taskQueue.assignTask(conn.memberCode, conn.vesselId);
            if (task) {
              rest.setTyping(conn.memberCode, task.channelId);
              sendToVessel(ws, { type: "task:assign", task });
            }
            break;
          }
          case "task:complete": {
            // Content policy gate - validate before posting
            const policy = validateResponse(msg.response, conn.memberCode);
            if (!policy.pass) {
              console.warn(`[control-plane] response blocked: ${policy.reason}`);
              audit.log("response:blocked", { taskId: msg.taskId, memberCode: conn.memberCode, metadata: { reason: policy.reason } });
              taskQueue.failTask(msg.taskId, `Content policy: ${policy.reason}`);
            } else {
              const safeResponse = sanitizeResponse(msg.response);
              taskQueue.completeTask(msg.taskId, safeResponse);
              const completed = taskQueue.getRecentTasks("", 1).find((t) => t.id === msg.taskId);
              if (completed) {
                rest.postMessage(conn.memberCode, completed.channelId, safeResponse);
                memory.storeResponse(completed.channelId, conn.memberCode, safeResponse);
                audit.log("response:posted", { taskId: msg.taskId, memberCode: conn.memberCode, channelId: completed.channelId, content: safeResponse });
              }
            }
            // Assign next task if available
            const next = taskQueue.assignTask(conn.memberCode, conn.vesselId);
            if (next) sendToVessel(ws, { type: "task:assign", task: next });
            break;
          }
          case "task:failed": {
            taskQueue.failTask(msg.taskId, msg.error);
            console.error(`[control-plane] task ${msg.taskId} failed: ${msg.error}`);
            // Try next task
            const next = taskQueue.assignTask(conn.memberCode, conn.vesselId);
            if (next) sendToVessel(ws, { type: "task:assign", task: next });
            break;
          }
          case "heartbeat": {
            conn.lastHeartbeat = Date.now();
            healthMonitor.heartbeat(conn.vesselId, msg.status);
            sendToVessel(ws, { type: "heartbeat:ack" });
            break;
          }
        }
      },
      close(ws) {
        const conn = vessels.get(ws);
        if (conn) {
          console.log(`[control-plane] vessel ${conn.vesselId} disconnected`);
          healthMonitor.deregister(conn.vesselId);
          audit.log("vessel:disconnected", { vesselId: conn.vesselId, memberCode: conn.memberCode });
        }
        vessels.delete(ws);
      },
    },
  });

  // 7. Health check loop - recover stale tasks, check vessel health, push to idle vessels
  const healthInterval = setInterval(() => {
    const stale = taskQueue.recoverStaleTasks(config.staleTaskMaxAgeMs);
    if (stale > 0) console.log(`[control-plane] recovered ${stale} stale tasks`);
    // Check vessel health
    const alerts = healthMonitor.check();
    for (const alert of alerts) console.warn(`[control-plane] ${alert}`);
    // Prune old memory entries periodically
    memory.prune(50);
    // Push pending tasks to idle authenticated vessels
    for (const [ws, conn] of vessels) {
      if (!conn.authenticated) continue;
      const task = taskQueue.assignTask(conn.memberCode, conn.vesselId);
      if (task) sendToVessel(ws, { type: "task:assign", task });
    }
  }, config.healthCheckIntervalMs);

  // 8. Graceful shutdown
  function shutdown(signal: string): void {
    console.log(`[control-plane] ${signal} received, shutting down...`);
    clearInterval(healthInterval);
    for (const gw of gateways) gw.destroy();
    for (const [ws] of vessels) sendToVessel(ws, { type: "shutdown" });
    vesselServer.stop();
    taskQueue.close();
    memory.close();
    audit.close();
    console.log("[control-plane] stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const stats = taskQueue.getStats();
  console.log(`[control-plane] ready - vessel ws://localhost:${config.vesselPort}`);
  console.log(`[control-plane] ${config.members.length} members, ${stats.pending} pending tasks`);
}
