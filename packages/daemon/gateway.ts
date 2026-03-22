/**
 * Gateway - WebSocket server for the daemon.
 *
 * Accepts connections from OS frontend, Telegram, Discord, etc.
 * Routes messages to the AgentPool, broadcasts agent events to clients.
 */

import { bus, type EventName } from "./events";
import type { AgentPool } from "./agent-pool";
import { getJobs, addJob, removeJob, type CronJob } from "./cron";

export interface GatewayConfig {
  port: number;
  authToken: string | null; // null = no auth required
  pool: AgentPool;
}

interface ClientState {
  id: string;
  channel: string; // "os", "telegram", "discord", "api"
  sessionId: string | null;
  authenticated: boolean;
}

type InboundMessage =
  | { type: "auth"; token: string }
  | { type: "session:create"; channel: string }
  | { type: "session:resume"; sessionId: string }
  | { type: "session:compact"; sessionId: string }
  | { type: "session:destroy"; sessionId: string }
  | { type: "prompt"; text: string }
  | { type: "sessions:list" }
  | { type: "cron:list" }
  | { type: "cron:add"; job: unknown }
  | { type: "cron:remove"; jobId: string }
  | { type: "health" }
  | { type: "ping" };

type OutboundMessage =
  | { type: "auth:ok" }
  | { type: "auth:fail" }
  | { type: "session:created"; sessionId: string }
  | { type: "session:resumed"; sessionId: string }
  | { type: "sessions:list"; sessions: unknown[] }
  | { type: "cron:list"; jobs: unknown[] }
  | { type: "cron:added"; jobId: string }
  | { type: "cron:removed"; jobId: string }
  | { type: "health"; data: unknown }
  | { type: "event"; event: EventName; payload: unknown }
  | { type: "error"; message: string }
  | { type: "pong" };

const clients = new Map<any, ClientState>();
let nextClientId = 0;

function generateSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function send(ws: any, msg: OutboundMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Client disconnected
  }
}

function broadcastToSession(sessionId: string, event: EventName, payload: unknown): void {
  for (const [ws, state] of clients) {
    if (state.sessionId === sessionId && state.authenticated) {
      send(ws, { type: "event", event, payload });
    }
  }
}

function handleMessage(ws: any, config: GatewayConfig, raw: string): void {
  const state = clients.get(ws);
  if (!state) return;

  let msg: InboundMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, { type: "error", message: "invalid JSON" });
    return;
  }

  // Auth check
  if (config.authToken && !state.authenticated) {
    if (msg.type === "auth") {
      if (msg.token === config.authToken) {
        state.authenticated = true;
        send(ws, { type: "auth:ok" });
      } else {
        send(ws, { type: "auth:fail" });
      }
      return;
    }
    send(ws, { type: "error", message: "not authenticated" });
    return;
  }

  const pool = config.pool;

  switch (msg.type) {
    case "ping":
      send(ws, { type: "pong" });
      break;

    case "session:create": {
      const sessionId = generateSessionId();
      state.sessionId = sessionId;
      state.channel = msg.channel || "api";

      // Respond immediately - agent creation can be slow (AST indexing)
      bus.emit("session:start", { sessionId, channel: state.channel });
      send(ws, { type: "session:created", sessionId });

      // Create Agent instance async (doesn't block the response)
      setTimeout(() => pool.createSession(sessionId, state.channel), 0);
      break;
    }

    case "session:resume": {
      state.sessionId = msg.sessionId;

      // If pool doesn't have this session, create a new agent for it
      if (!pool.hasSession(msg.sessionId)) {
        pool.createSession(msg.sessionId, state.channel);
      }

      bus.emit("session:start", { sessionId: msg.sessionId, channel: state.channel });
      send(ws, { type: "session:resumed", sessionId: msg.sessionId });
      break;
    }

    case "session:compact": {
      if (msg.sessionId) {
        bus.emit("agent:thinking", { sessionId: msg.sessionId });
      }
      break;
    }

    case "session:destroy": {
      if (msg.sessionId) {
        pool.destroySession(msg.sessionId);
        bus.emit("session:end", { sessionId: msg.sessionId, reason: "client-destroy" });
        for (const [, s] of clients) {
          if (s.sessionId === msg.sessionId) s.sessionId = null;
        }
      }
      break;
    }

    case "prompt": {
      if (!state.sessionId) {
        send(ws, { type: "error", message: "no active session" });
        return;
      }

      // Route the message to the agent via the pool
      // This runs async - events will be broadcast as the agent works
      const sid = state.sessionId;
      pool.chat(sid, msg.text).then((response) => {
        // Final response - signal session:end for this turn
        bus.emit("session:end", { sessionId: sid, reason: "turn-complete" });
      }).catch((err) => {
        bus.emit("agent:error", {
          sessionId: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      break;
    }

    case "sessions:list": {
      send(ws, { type: "sessions:list", sessions: pool.getActiveSessions() });
      break;
    }

    case "cron:list": {
      send(ws, { type: "cron:list", jobs: getJobs() });
      break;
    }

    case "cron:add": {
      const job = msg.job as CronJob;
      if (!job || !job.id || !job.name) {
        send(ws, { type: "error", message: "invalid cron job: requires id, name, expression, type, payload" });
        break;
      }
      addJob(job);
      send(ws, { type: "cron:added", jobId: job.id });
      break;
    }

    case "cron:remove": {
      const removed = removeJob(msg.jobId);
      if (removed) {
        send(ws, { type: "cron:removed", jobId: msg.jobId });
      } else {
        send(ws, { type: "error", message: `cron job ${msg.jobId} not found` });
      }
      break;
    }

    case "health": {
      send(ws, {
        type: "health",
        data: {
          status: "ok",
          sessions: pool.size,
          uptime: process.uptime(),
          cronJobs: getJobs().length,
        },
      });
      break;
    }

    default:
      send(ws, { type: "error", message: "unknown message type" });
  }
}

/** Subscribe the gateway to all bus events and broadcast to relevant sessions */
function subscribeToBus(): void {
  const events: EventName[] = [
    "tool:start", "tool:result", "agent:thinking", "agent:stream",
    "agent:error", "memory:saved", "approval:required", "session:start", "session:end",
  ];
  for (const event of events) {
    bus.on(event, (payload: any) => {
      if (payload.sessionId) {
        broadcastToSession(payload.sessionId, event, payload);
      }
    });
  }
}

export function startGateway(config: GatewayConfig): ReturnType<typeof Bun.serve> {
  subscribeToBus();

  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;

      // Health check endpoint
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({
          status: "ok",
          sessions: config.pool.size,
          uptime: process.uptime(),
        });
      }

      return new Response("Eight Daemon - ws://localhost:" + config.port, { status: 200 });
    },
    websocket: {
      open(ws) {
        const id = `c_${nextClientId++}`;
        clients.set(ws, {
          id,
          channel: "api",
          sessionId: null,
          authenticated: !config.authToken,
        });
        console.log(`[gateway] client ${id} connected`);
      },
      message(ws, raw) {
        handleMessage(ws, config, typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      },
      close(ws) {
        const state = clients.get(ws);
        if (state) {
          console.log(`[gateway] client ${state.id} disconnected`);
          if (state.sessionId) {
            bus.emit("session:end", { sessionId: state.sessionId, reason: "client-disconnect" });
          }
        }
        clients.delete(ws);
      },
    },
  });

  console.log(`[gateway] WebSocket server listening on ws://localhost:${config.port}`);
  return server;
}
