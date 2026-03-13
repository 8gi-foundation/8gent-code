/**
 * Shared types for the message broker system.
 *
 * This file has NO bugs — it defines the contracts
 * that broker.ts, history.ts, and router.ts must satisfy.
 */

// ── Core Message Types ──────────────────────────────────────────────

/** A message published to a topic. */
export interface Message {
  id: string;
  topic: string;
  payload: unknown;
  timestamp: number;
  /** Optional metadata attached by the publisher. */
  metadata?: Record<string, unknown>;
}

/** A subscription handle returned when subscribing to a topic. */
export interface Subscription {
  id: string;
  topic: string;
  handler: MessageHandler;
  /** If true, the subscription auto-unsubscribes after one message. */
  once: boolean;
  createdAt: number;
}

/** Callback invoked when a message arrives on a subscribed topic. */
export type MessageHandler = (message: Message) => void | Promise<void>;

// ── Topic Configuration ─────────────────────────────────────────────

/** Per-topic configuration. */
export interface Topic {
  name: string;
  /** Max messages retained in history for this topic. */
  maxHistory: number;
  /** If true, new subscribers receive the last N messages on subscribe. */
  replayOnSubscribe: boolean;
  createdAt: number;
}

// ── Options ─────────────────────────────────────────────────────────

/** Options for creating a MessageBroker instance. */
export interface BrokerOptions {
  /** Default maxHistory for topics that don't specify one. */
  defaultMaxHistory: number;
  /** Whether to enable pattern-based topic matching (wildcards). */
  enablePatternMatching: boolean;
  /** If true, publish() returns a Promise that resolves when all handlers finish. */
  awaitHandlers: boolean;
}

/** Options for querying message history. */
export interface HistoryOptions {
  /** Maximum number of messages to return. Defaults to the topic's maxHistory. */
  limit?: number;
  /** Only return messages after this timestamp. */
  since?: number;
  /** Only return messages before this timestamp. */
  until?: number;
}
