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

interface VesselConnection {
  ws: any;
  memberCode: string;
  vesselId: string;
  authenticated: boolean;
  lastHeartbeat: number;
}

export async function startControlPlane(config: ControlPlaneConfig): Promise<void> {
  console.log("[control-plane] starting...");

  // 1. Open task queue
  const taskQueue = new TaskQueue(config.dbPath);

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
        return Response.json({ status: "ok", stats: taskQueue.getStats(), vessels: vessels.size });
      }
      return new Response("Board Control Plane", { status: 200 });
    },
    websocket: {
      open(ws) {
        const id = `v_${nextVesselId++}`;
        vessels.set(ws, { ws, memberCode: "", vesselId: id, authenticated: false, lastHeartbeat: Date.now() });
        console.log(`[control-plane] vessel ${id} connected`);
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
            sendToVessel(ws, { type: "auth:ok", vesselId: conn.vesselId });
            console.log(`[control-plane] vessel ${conn.vesselId} authenticated as ${msg.memberCode}`);
          } else {
            sendToVessel(ws, { type: "auth:fail", reason: "invalid token" });
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
            taskQueue.completeTask(msg.taskId, msg.response);
            // Post response to Discord
            const completed = taskQueue.getRecentTasks("", 1).find((t) => t.id === msg.taskId);
            if (completed) rest.postMessage(conn.memberCode, completed.channelId, msg.response);
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
            sendToVessel(ws, { type: "heartbeat:ack" });
            break;
          }
        }
      },
      close(ws) {
        const conn = vessels.get(ws);
        if (conn) console.log(`[control-plane] vessel ${conn.vesselId} disconnected`);
        vessels.delete(ws);
      },
    },
  });

  // 7. Health check loop - recover stale tasks, push to idle vessels
  const healthInterval = setInterval(() => {
    const stale = taskQueue.recoverStaleTasks(config.staleTaskMaxAgeMs);
    if (stale > 0) console.log(`[control-plane] recovered ${stale} stale tasks`);
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
    console.log("[control-plane] stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const stats = taskQueue.getStats();
  console.log(`[control-plane] ready - vessel ws://localhost:${config.vesselPort}`);
  console.log(`[control-plane] ${config.members.length} members, ${stats.pending} pending tasks`);
}
