/**
 * MessageBroker - file-based pub/sub with topics, persistence, consumer groups,
 * acknowledgment, dead letter queue, and replay.
 *
 * Zero external dependencies. Uses Bun's built-in fs APIs.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message<T = unknown> {
  id: string;
  topic: string;
  payload: T;
  publishedAt: number;
  attempts: number;
  headers?: Record<string, string>;
}

export interface ConsumedMessage<T = unknown> extends Message<T> {
  consumerId: string;
  consumerGroup: string;
  deliveredAt: number;
}

export interface BrokerOptions {
  /** Root directory for all broker state. Default: ".8gent/broker" */
  dataDir?: string;
  /** Max delivery attempts before moving to DLQ. Default: 3 */
  maxAttempts?: number;
  /** Visibility timeout in ms - message is re-queued if not acked. Default: 30_000 */
  visibilityTimeoutMs?: number;
}

export interface PublishOptions {
  headers?: Record<string, string>;
}

export interface ConsumeOptions {
  /** Max messages to return in one poll. Default: 10 */
  batchSize?: number;
}

export interface AckResult {
  messageId: string;
  success: boolean;
}

export interface ReplayOptions {
  /** Unix timestamp (ms) - replay messages published after this time */
  fromTimestamp?: number;
  /** Max messages to replay. Default: all */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// MessageBroker
// ---------------------------------------------------------------------------

export class MessageBroker {
  private readonly dataDir: string;
  private readonly maxAttempts: number;
  private readonly visibilityTimeoutMs: number;

  constructor(options: BrokerOptions = {}) {
    this.dataDir = options.dataDir ?? ".8gent/broker";
    this.maxAttempts = options.maxAttempts ?? 3;
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
    ensureDir(this.dataDir);
  }

  // -------------------------------------------------------------------------
  // Directory helpers
  // -------------------------------------------------------------------------

  private topicDir(topic: string): string {
    return join(this.dataDir, "topics", topic);
  }

  private queueDir(topic: string, group: string): string {
    return join(this.dataDir, "queues", topic, group);
  }

  private inflightDir(topic: string, group: string): string {
    return join(this.dataDir, "inflight", topic, group);
  }

  private dlqDir(topic: string, group: string): string {
    return join(this.dataDir, "dlq", topic, group);
  }

  private archiveDir(topic: string): string {
    return join(this.dataDir, "archive", topic);
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  /**
   * Publish a message to a topic. Written to the archive (replay log) and
   * fanned out to all registered consumer groups.
   */
  publish<T = unknown>(topic: string, payload: T, options: PublishOptions = {}): Message<T> {
    const message: Message<T> = {
      id: generateId(),
      topic,
      payload,
      publishedAt: Date.now(),
      attempts: 0,
      headers: options.headers,
    };

    // Persist to archive (replay log)
    const archiveDir = this.archiveDir(topic);
    ensureDir(archiveDir);
    writeJson(join(archiveDir, `${message.id}.json`), message);

    // Fan out to all known consumer groups for this topic
    const groups = this.listGroups(topic);
    for (const group of groups) {
      this.enqueueForGroup(topic, group, message);
    }

    return message;
  }

  private enqueueForGroup<T>(topic: string, group: string, message: Message<T>): void {
    const dir = this.queueDir(topic, group);
    ensureDir(dir);
    writeJson(join(dir, `${message.id}.json`), message);
  }

  // -------------------------------------------------------------------------
  // Subscribe / consumer groups
  // -------------------------------------------------------------------------

  /**
   * Register a consumer group for a topic. Idempotent.
   * Must be called before consuming so publish knows to fan out.
   */
  subscribe(topic: string, group: string): void {
    const dir = this.topicDir(topic);
    ensureDir(dir);
    const registryPath = join(dir, "groups.json");
    const groups: string[] = readJson<string[]>(registryPath) ?? [];
    if (!groups.includes(group)) {
      groups.push(group);
      writeJson(registryPath, groups);
    }
    ensureDir(this.queueDir(topic, group));
    ensureDir(this.inflightDir(topic, group));
    ensureDir(this.dlqDir(topic, group));
  }

  /**
   * Unsubscribe a consumer group. Remaining queued messages are abandoned.
   */
  unsubscribe(topic: string, group: string): void {
    const dir = this.topicDir(topic);
    const registryPath = join(dir, "groups.json");
    const groups: string[] = readJson<string[]>(registryPath) ?? [];
    writeJson(registryPath, groups.filter((g) => g !== group));
  }

  private listGroups(topic: string): string[] {
    const registryPath = join(this.topicDir(topic), "groups.json");
    return readJson<string[]>(registryPath) ?? [];
  }

  // -------------------------------------------------------------------------
  // Consume
  // -------------------------------------------------------------------------

  /**
   * Poll for messages. Moves them to inflight and returns them.
   * Consumer must ack() within visibilityTimeoutMs or the message is re-queued.
   */
  consume<T = unknown>(
    topic: string,
    group: string,
    consumerId: string,
    options: ConsumeOptions = {}
  ): ConsumedMessage<T>[] {
    const batchSize = options.batchSize ?? 10;

    // Reclaim any expired inflight messages first
    this.reclaimExpired(topic, group);

    const queueDir = this.queueDir(topic, group);
    ensureDir(queueDir);

    const files = readdirSync(queueDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .slice(0, batchSize);

    const results: ConsumedMessage<T>[] = [];
    const inflightDir = this.inflightDir(topic, group);
    ensureDir(inflightDir);
    const now = Date.now();

    for (const file of files) {
      const src = join(queueDir, file);
      const message = readJson<Message<T>>(src);
      if (!message) continue;

      message.attempts += 1;

      const consumed: ConsumedMessage<T> = {
        ...message,
        consumerId,
        consumerGroup: group,
        deliveredAt: now,
      };

      const inflightPath = join(inflightDir, file);
      writeJson(inflightPath, consumed);

      try {
        unlinkSync(src);
      } catch {
        // Another consumer grabbed it - skip
        try { unlinkSync(inflightPath); } catch { /* ignore */ }
        continue;
      }

      results.push(consumed);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Acknowledgment
  // -------------------------------------------------------------------------

  /** Acknowledge successful processing. Removes from inflight. */
  ack(topic: string, group: string, messageId: string): AckResult {
    const inflightPath = join(this.inflightDir(topic, group), `${messageId}.json`);
    if (!existsSync(inflightPath)) {
      return { messageId, success: false };
    }
    try {
      unlinkSync(inflightPath);
      return { messageId, success: true };
    } catch {
      return { messageId, success: false };
    }
  }

  /** Negative-acknowledge. Re-queues if under maxAttempts, otherwise sends to DLQ. */
  nack(topic: string, group: string, messageId: string): AckResult {
    const inflightPath = join(this.inflightDir(topic, group), `${messageId}.json`);
    const message = readJson<ConsumedMessage>(inflightPath);
    if (!message) {
      return { messageId, success: false };
    }

    try {
      unlinkSync(inflightPath);
    } catch {
      return { messageId, success: false };
    }

    if (message.attempts >= this.maxAttempts) {
      this.sendToDlq(topic, group, message);
    } else {
      this.enqueueForGroup(topic, group, message);
    }

    return { messageId, success: true };
  }

  // -------------------------------------------------------------------------
  // Visibility timeout / reclaim
  // -------------------------------------------------------------------------

  private reclaimExpired(topic: string, group: string): void {
    const dir = this.inflightDir(topic, group);
    if (!existsSync(dir)) return;

    const now = Date.now();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const path = join(dir, file);
      const msg = readJson<ConsumedMessage>(path);
      if (!msg) continue;

      if (now - msg.deliveredAt >= this.visibilityTimeoutMs) {
        try { unlinkSync(path); } catch { continue; }
        if (msg.attempts >= this.maxAttempts) {
          this.sendToDlq(topic, group, msg);
        } else {
          this.enqueueForGroup(topic, group, msg);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dead letter queue
  // -------------------------------------------------------------------------

  private sendToDlq(topic: string, group: string, message: ConsumedMessage | Message): void {
    const dir = this.dlqDir(topic, group);
    ensureDir(dir);
    writeJson(join(dir, `${message.id}.json`), message);
  }

  /** List all messages in the DLQ for a topic/group. */
  listDlq<T = unknown>(topic: string, group: string): Message<T>[] {
    const dir = this.dlqDir(topic, group);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => readJson<Message<T>>(join(dir, f)))
      .filter((m): m is Message<T> => m !== null);
  }

  /** Re-queue all DLQ messages for a topic/group (resets attempt count). */
  replayDlq(topic: string, group: string): number {
    const dir = this.dlqDir(topic, group);
    if (!existsSync(dir)) return 0;

    let count = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const path = join(dir, file);
      const msg = readJson<Message>(path);
      if (!msg) continue;
      msg.attempts = 0;
      this.enqueueForGroup(topic, group, msg);
      try { unlinkSync(path); } catch { /* ignore */ }
      count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Replay from archive
  // -------------------------------------------------------------------------

  /**
   * Replay archived messages for a topic into a consumer group's queue.
   * Useful for new subscribers that want historical messages.
   */
  replay(topic: string, group: string, options: ReplayOptions = {}): number {
    const archiveDir = this.archiveDir(topic);
    if (!existsSync(archiveDir)) return 0;

    const fromTimestamp = options.fromTimestamp ?? 0;
    const limit = options.limit ?? Infinity;

    const files = readdirSync(archiveDir)
      .filter((f) => f.endsWith(".json"))
      .sort();

    let count = 0;
    for (const file of files) {
      if (count >= limit) break;
      const msg = readJson<Message>(join(archiveDir, file));
      if (!msg || msg.publishedAt < fromTimestamp) continue;
      msg.attempts = 0;
      this.enqueueForGroup(topic, group, msg);
      count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** Queue depth for a topic/group. */
  depth(topic: string, group: string): number {
    const dir = this.queueDir(topic, group);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  }

  /** Inflight count for a topic/group. */
  inflight(topic: string, group: string): number {
    const dir = this.inflightDir(topic, group);
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  }

  /** DLQ depth for a topic/group. */
  dlqDepth(topic: string, group: string): number {
    return this.listDlq(topic, group).length;
  }

  /** List all registered topics. */
  listTopics(): string[] {
    const topicsDir = join(this.dataDir, "topics");
    if (!existsSync(topicsDir)) return [];
    return readdirSync(topicsDir);
  }

  /** Stats snapshot for a topic/group. */
  stats(topic: string, group: string): {
    topic: string;
    group: string;
    queued: number;
    inflight: number;
    dlq: number;
  } {
    return {
      topic,
      group,
      queued: this.depth(topic, group),
      inflight: this.inflight(topic, group),
      dlq: this.dlqDepth(topic, group),
    };
  }

  // -------------------------------------------------------------------------
  // Purge
  // -------------------------------------------------------------------------

  /** Purge all pending messages for a topic/group (does not touch inflight or DLQ). */
  purge(topic: string, group: string): number {
    const dir = this.queueDir(topic, group);
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
    }
    return files.length;
  }
}
