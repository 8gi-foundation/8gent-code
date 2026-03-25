/**
 * RequestLogger - WebSocket message logging middleware for the daemon gateway.
 *
 * Subscribes to the EventBus and logs all inbound/outbound WebSocket messages
 * with timestamps, session IDs, message types, and payload sizes.
 * Verbosity is configurable: "silent" | "minimal" | "normal" | "verbose".
 */

import { bus, type EventName } from "./events";

export type Verbosity = "silent" | "minimal" | "normal" | "verbose";

export interface RequestLoggerConfig {
  /** Logging verbosity. Default: "normal" */
  verbosity?: Verbosity;
  /** Custom log function. Default: console.log */
  log?: (...args: unknown[]) => void;
  /** Custom error log function. Default: console.error */
  logError?: (...args: unknown[]) => void;
}

export interface LogEntry {
  timestamp: string;
  sessionId: string | null;
  direction: "inbound" | "outbound" | "internal";
  messageType: string;
  payloadBytes: number;
}

const PREFIX = "[request-logger]";

function byteSize(payload: unknown): number {
  if (payload === undefined || payload === null) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  } catch {
    return 0;
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Log a single WebSocket message (inbound or outbound).
 * Call this from gateway message handlers as middleware.
 */
export function logMessage(
  config: RequestLoggerConfig,
  direction: "inbound" | "outbound",
  sessionId: string | null,
  messageType: string,
  payload: unknown,
): LogEntry {
  const entry: LogEntry = {
    timestamp: timestamp(),
    sessionId,
    direction,
    messageType,
    payloadBytes: byteSize(payload),
  };

  const { verbosity = "normal", log = console.log } = config;

  if (verbosity === "silent") return entry;

  if (verbosity === "minimal") {
    log(`${PREFIX} ${direction} ${messageType}`);
    return entry;
  }

  // normal - type, session, size
  const sid = sessionId ?? "-";
  const size = `${entry.payloadBytes}B`;
  log(`${PREFIX} ${entry.timestamp} ${direction} type=${messageType} session=${sid} size=${size}`);

  if (verbosity === "verbose" && payload !== undefined) {
    log(`${PREFIX}   payload:`, JSON.stringify(payload, null, 2));
  }

  return entry;
}

/**
 * Subscribe to the daemon EventBus and log all events as internal messages.
 * Returns unsubscribe function.
 */
export function attachBusLogger(config: RequestLoggerConfig = {}): () => void {
  const { verbosity = "normal", log = console.log, logError = console.error } = config;
  if (verbosity === "silent") return () => {};

  const events: EventName[] = [
    "tool:start", "tool:result", "agent:thinking", "agent:stream",
    "agent:error", "memory:saved", "approval:required",
    "session:start", "session:end",
    "task:created", "task:delegated", "task:progress", "task:completed", "task:failed",
  ];

  const ids: number[] = [];

  for (const event of events) {
    const id = bus.on(event, (payload: any) => {
      const sid = payload?.sessionId ?? payload?.taskId ?? null;
      const size = byteSize(payload);

      if (verbosity === "minimal") {
        log(`${PREFIX} event ${event}`);
        return;
      }

      log(`${PREFIX} ${timestamp()} internal event=${event} session=${sid ?? "-"} size=${size}B`);

      if (verbosity === "verbose") {
        log(`${PREFIX}   payload:`, JSON.stringify(payload, null, 2));
      }
    });
    ids.push(id);
  }

  log(`${PREFIX} attached to EventBus (${ids.length} events, verbosity=${verbosity})`);

  return () => {
    for (const id of ids) bus.off(id);
    log(`${PREFIX} detached from EventBus`);
  };
}
