/**
 * EightClient - WebSocket client for the Eight daemon.
 *
 * Auto-reconnect with exponential backoff, typed messages,
 * event emitter pattern. Works in any JS runtime (Bun, Node, browser).
 */

import type { DaemonEvents, EventName } from "./events";

// -- Inbound (server -> client) message types --------------------------------

type ServerMessage =
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

// -- Outbound (client -> server) message types --------------------------------

type ClientMessage =
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
  | { type: "approval:response"; requestId: string; approved: boolean }
  | { type: "ping" };

// -- Client events (connection lifecycle + daemon events) ---------------------

interface ClientEvents {
  open: undefined;
  close: { code: number; reason: string };
  error: { error: unknown };
  reconnecting: { attempt: number; delayMs: number };
  message: ServerMessage;
  // All daemon events forwarded
  "daemon:event": { event: EventName; payload: unknown };
}

type ClientEventName = keyof ClientEvents;
type Handler<T> = (payload: T) => void;

// -- Config -------------------------------------------------------------------

export interface EightClientConfig {
  /** WebSocket URL, e.g. "ws://localhost:18789" */
  url: string;
  /** Auth token. Omit if daemon has no auth. */
  authToken?: string;
  /** Auto-reconnect on disconnect. Default true. */
  autoReconnect?: boolean;
  /** Max reconnect attempts before giving up. 0 = infinite. Default 0. */
  maxReconnectAttempts?: number;
  /** Base delay for exponential backoff in ms. Default 1000. */
  baseDelayMs?: number;
  /** Max backoff delay in ms. Default 30000. */
  maxDelayMs?: number;
}

// -- Client -------------------------------------------------------------------

export class EightClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Handler<any>>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  readonly url: string;
  private readonly authToken: string | undefined;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(config: EightClientConfig) {
    this.url = config.url;
    this.authToken = config.authToken;
    this.autoReconnect = config.autoReconnect ?? true;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 0;
    this.baseDelayMs = config.baseDelayMs ?? 1000;
    this.maxDelayMs = config.maxDelayMs ?? 30_000;
  }

  // -- Connection lifecycle ---------------------------------------------------

  connect(): void {
    this.intentionalClose = false;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      if (this.authToken) {
        this.send({ type: "auth", token: this.authToken });
      }
      this.emit("open", undefined);
    };

    this.ws.onclose = (ev) => {
      const info = { code: ev.code, reason: ev.reason };
      this.emit("close", info);
      this.ws = null;
      if (!this.intentionalClose && this.autoReconnect) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (ev) => {
      this.emit("error", { error: ev });
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg: ServerMessage = JSON.parse(
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data)
        );
        this.emit("message", msg);
        if (msg.type === "event") {
          this.emit("daemon:event", { event: msg.event, payload: msg.payload });
        }
      } catch {
        // Malformed message - ignore
      }
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // -- Reconnect --------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.maxReconnectAttempts > 0 && this.reconnectAttempt >= this.maxReconnectAttempts) {
      return;
    }
    const jitter = Math.random() * 0.3 + 0.85; // 0.85-1.15x
    const delay = Math.min(this.baseDelayMs * 2 ** this.reconnectAttempt * jitter, this.maxDelayMs);
    this.reconnectAttempt++;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  // -- Send typed messages ----------------------------------------------------

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("EightClient: not connected");
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Send a prompt to the current session */
  prompt(text: string): void {
    this.send({ type: "prompt", text });
  }

  /** Create a new session */
  createSession(channel = "api"): void {
    this.send({ type: "session:create", channel });
  }

  /** Resume an existing session */
  resumeSession(sessionId: string): void {
    this.send({ type: "session:resume", sessionId });
  }

  /** Request health info */
  health(): void {
    this.send({ type: "health" });
  }

  /** Ping the daemon */
  ping(): void {
    this.send({ type: "ping" });
  }

  // -- Event emitter ----------------------------------------------------------

  on<E extends ClientEventName>(event: E, handler: Handler<ClientEvents[E]>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off<E extends ClientEventName>(event: E, handler: Handler<ClientEvents[E]>): void {
    this.listeners.get(event)?.delete(handler);
  }

  /** Subscribe to a specific daemon event type */
  onDaemonEvent<E extends EventName>(
    event: E,
    handler: (payload: DaemonEvents[E]) => void,
  ): () => void {
    return this.on("daemon:event", (data) => {
      if (data.event === event) {
        handler(data.payload as DaemonEvents[E]);
      }
    });
  }

  /** Wait for a specific message type. Resolves with the message or rejects on timeout. */
  waitFor<T extends ServerMessage["type"]>(
    type: T,
    timeoutMs = 10_000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`EightClient: timeout waiting for "${type}"`));
      }, timeoutMs);

      const cleanup = this.on("message", (msg) => {
        if (msg.type === type) {
          clearTimeout(timer);
          cleanup();
          resolve(msg as Extract<ServerMessage, { type: T }>);
        }
      });
    });
  }

  private emit<E extends ClientEventName>(event: E, payload: ClientEvents[E]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EightClient] handler error on "${event}":`, err);
      }
    }
  }

  // -- Cleanup ----------------------------------------------------------------

  destroy(): void {
    this.disconnect();
    this.listeners.clear();
  }
}
