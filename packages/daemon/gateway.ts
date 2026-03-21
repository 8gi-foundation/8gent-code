/**
 * Gateway - WebSocket server for the daemon.
 *
 * Accepts connections from OS frontend, Telegram, Discord, etc.
 * Routes messages to sessions, broadcasts agent events to clients.
 */

import { bus, type EventName, type EventPayload } from "./events";

export interface GatewayConfig {
  port: number;
  authToken: string | null; // null = no auth required
}

interface ClientState {
  id: string;
  channel: string; // "tui", "telegram", "discord", "api"
  sessionId: string | null;
  authenticated: boolean;
}

type InboundMessage =
  | { type: "auth"; token: string }
  | { type: "session:create"; channel: string }
  | { type: "session:resume"; sessionId: string }
  | { type: "session:compact"; sessionId: string }
  | { type: "session:destroy"; sessionId: string }
  | { type: "tool:execute"; tool: string; input: unknown }
  | { type: "prompt"; text: string }
  | { type: "ping" };

type OutboundMessage =
  | { type: "auth:ok" }
  | { type: "auth:fail" }
  | { type: "session:created"; sessionId: string }
  | { type: "session:resumed"; sessionId: string }
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

  switch (msg.type) {
    case "ping":
      send(ws, { type: "pong" });
      break;

    case "session:create": {
      const sessionId = generateSessionId();
      state.sessionId = sessionId;
      state.channel = msg.channel || "api";
      bus.emit("session:start", { sessionId, channel: state.channel });
      send(ws, { type: "session:created", sessionId });
      break;
    }

    case "session:resume": {
      state.sessionId = msg.sessionId;
      bus.emit("session:start", { sessionId: msg.sessionId, channel: state.channel });
      send(ws, { type: "session:resumed", sessionId: msg.sessionId });
      break;
    }

    case "session:compact": {
      // Signal to agent to compact the session history
      if (msg.sessionId) {
        bus.emit("agent:thinking", { sessionId: msg.sessionId });
      }
      break;
    }

    case "session:destroy": {
      if (msg.sessionId) {
        bus.emit("session:end", { sessionId: msg.sessionId, reason: "client-destroy" });
        // Clear sessionId from any clients using it
        for (const [, s] of clients) {
          if (s.sessionId === msg.sessionId) s.sessionId = null;
        }
      }
      break;
    }

    case "tool:execute": {
      if (!state.sessionId) {
        send(ws, { type: "error", message: "no active session" });
        return;
      }
      bus.emit("tool:start", { sessionId: state.sessionId, tool: msg.tool, input: msg.input });
      break;
    }

    case "prompt": {
      if (!state.sessionId) {
        send(ws, { type: "error", message: "no active session" });
        return;
      }
      bus.emit("agent:thinking", { sessionId: state.sessionId });
      break;
    }

    default:
      send(ws, { type: "error", message: `unknown message type` });
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
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("Eight Daemon WebSocket", { status: 200 });
    },
    websocket: {
      open(ws) {
        const id = `c_${nextClientId++}`;
        clients.set(ws, {
          id,
          channel: "api",
          sessionId: null,
          authenticated: !config.authToken, // auto-auth if no token required
        });
      },
      message(ws, raw) {
        handleMessage(ws, config, typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      },
      close(ws) {
        const state = clients.get(ws);
        if (state?.sessionId) {
          bus.emit("session:end", { sessionId: state.sessionId, reason: "client-disconnect" });
        }
        clients.delete(ws);
      },
    },
  });

  console.log(`[gateway] WebSocket server listening on ws://localhost:${config.port}`);
  return server;
}
