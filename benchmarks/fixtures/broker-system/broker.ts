/**
 * Message Broker — Pub/Sub system with topic management.
 *
 * Supports subscribing to topics, publishing messages, and
 * one-shot subscriptions. Uses copy-on-write arrays for
 * subscriber lists to avoid issues with concurrent iteration
 * and modification.
 *
 * CONTRACT:
 *  - subscribe() adds a handler to a topic; returns a Subscription.
 *  - unsubscribe() removes a handler by subscription ID.
 *  - publish() delivers a message to all active subscribers on the topic.
 *  - Concurrent subscribe/unsubscribe on the same topic MUST be safe:
 *    no subscribers should be silently lost.
 *  - Lifecycle hooks (onSubscribe/onUnsubscribe) are awaited before
 *    the operation completes, enabling middleware-like extension.
 */

import type {
  Message,
  Subscription,
  MessageHandler,
  Topic,
  BrokerOptions,
} from "./types";
import { HistoryStore } from "./history";
import { TopicRouter } from "./router";

// ── Helpers ─────────────────────────────────────────────────────────

let _subIdCounter = 0;
function nextSubId(): string {
  return `sub_${++_subIdCounter}_${Date.now().toString(36)}`;
}

let _msgIdCounter = 0;
function nextMsgId(): string {
  return `msg_${++_msgIdCounter}_${Date.now().toString(36)}`;
}

// ── Lifecycle Hooks ─────────────────────────────────────────────────

export type LifecycleHook = (topicName: string, subscriptionId: string) => void | Promise<void>;

// ── MessageBroker ───────────────────────────────────────────────────

export class MessageBroker {
  private topics = new Map<string, Topic>();
  private subscribers = new Map<string, Subscription[]>();
  private history: HistoryStore;
  private router: TopicRouter;
  private options: BrokerOptions;

  /** Optional lifecycle hooks — called during subscribe/unsubscribe. */
  onSubscribe: LifecycleHook | null = null;
  onUnsubscribe: LifecycleHook | null = null;

  constructor(options?: Partial<BrokerOptions>) {
    this.options = {
      defaultMaxHistory: 100,
      enablePatternMatching: true,
      awaitHandlers: true,
      ...options,
    };
    this.history = new HistoryStore();
    this.router = new TopicRouter();
  }

  // ── Topic Management ────────────────────────────────────────────

  /**
   * Creates a topic with the given configuration.
   * If the topic already exists, this is a no-op.
   */
  createTopic(name: string, maxHistory?: number, replayOnSubscribe = false): Topic {
    if (this.topics.has(name)) {
      return this.topics.get(name)!;
    }
    const topic: Topic = {
      name,
      maxHistory: maxHistory ?? this.options.defaultMaxHistory,
      replayOnSubscribe,
      createdAt: Date.now(),
    };
    this.topics.set(name, topic);
    this.subscribers.set(name, []);
    return topic;
  }

  /** Returns a topic by name, or null if it doesn't exist. */
  getTopic(name: string): Topic | null {
    return this.topics.get(name) ?? null;
  }

  /** Returns all registered topic names. */
  getTopicNames(): string[] {
    return [...this.topics.keys()];
  }

  // ── Subscribe / Unsubscribe ─────────────────────────────────────

  /**
   * Subscribes a handler to a topic. Auto-creates the topic if needed.
   *
   * Uses copy-on-write: reads the current subscriber array, creates a
   * new array with the new subscriber appended, and replaces the
   * reference. This way, any publish() currently iterating the old
   * array is not affected.
   *
   * If an onSubscribe hook is configured, it is awaited between
   * reading the current list and writing the updated one — this
   * enables middleware to validate or log subscriptions.
   */
  async subscribe(topicName: string, handler: MessageHandler, once = false): Promise<Subscription> {
    // Ensure topic exists
    if (!this.topics.has(topicName)) {
      this.createTopic(topicName);
    }

    const subscription: Subscription = {
      id: nextSubId(),
      topic: topicName,
      handler,
      once,
      createdAt: Date.now(),
    };

    // Copy-on-write: read current list
    const current = this.subscribers.get(topicName) ?? [];

    // Await lifecycle hook if configured (allows middleware-like extension)
    if (this.onSubscribe) {
      await this.onSubscribe(topicName, subscription.id);
    }

    // Append subscriber and replace the list
    const updated = [...current, subscription];
    this.subscribers.set(topicName, updated);

    return subscription;
  }

  /**
   * Removes a subscription by ID. Returns true if found and removed.
   *
   * Also uses copy-on-write: reads the current array, filters out
   * the target subscription, and replaces the reference atomically.
   *
   * If an onUnsubscribe hook is configured, it is awaited between
   * reading the current list and writing the filtered one.
   */
  async unsubscribe(subscriptionId: string): Promise<boolean> {
    for (const [topicName, subs] of this.subscribers.entries()) {
      const idx = subs.findIndex((s) => s.id === subscriptionId);
      if (idx !== -1) {
        // Read the current state
        const currentSubs = this.subscribers.get(topicName) ?? [];

        // Await lifecycle hook if configured
        if (this.onUnsubscribe) {
          await this.onUnsubscribe(topicName, subscriptionId);
        }

        // Copy-on-write: filter and replace
        const updated = currentSubs.filter((s) => s.id !== subscriptionId);
        this.subscribers.set(topicName, updated);
        return true;
      }
    }
    return false;
  }

  /** Returns the number of active subscribers for a topic. */
  subscriberCount(topicName: string): number {
    return (this.subscribers.get(topicName) ?? []).length;
  }

  // ── Publish ─────────────────────────────────────────────────────

  /**
   * Publishes a message to a topic (and pattern-matched topics).
   *
   * Iterates the subscriber list snapshot at the time of publish.
   * One-shot subscriptions are removed after delivery.
   */
  async publish(topicName: string, payload: unknown, metadata?: Record<string, unknown>): Promise<Message> {
    // Ensure topic exists
    if (!this.topics.has(topicName)) {
      this.createTopic(topicName);
    }

    const message: Message = {
      id: nextMsgId(),
      topic: topicName,
      payload,
      timestamp: Date.now(),
      metadata,
    };

    // Store in history
    const topic = this.topics.get(topicName)!;
    this.history.addMessage(topicName, message, topic.maxHistory);

    // Collect all matching subscribers (direct + pattern matched)
    const directSubs = this.subscribers.get(topicName) ?? [];
    const matchedTopics = this.options.enablePatternMatching
      ? this.findPatternMatches(topicName)
      : [];

    const allSubs = [
      ...directSubs,
      ...matchedTopics.flatMap((t) => this.subscribers.get(t) ?? []),
    ];

    // Deliver to all subscribers
    const oneTimeSubs: string[] = [];

    const deliveries = allSubs.map(async (sub) => {
      try {
        if (this.options.awaitHandlers) {
          await sub.handler(message);
        } else {
          sub.handler(message);
        }
        if (sub.once) {
          oneTimeSubs.push(sub.id);
        }
      } catch (err) {
        // Subscriber errors are silently swallowed — broker stays up
        console.error(`Subscriber ${sub.id} error:`, err);
      }
    });

    await Promise.all(deliveries);

    // Clean up one-shot subscriptions
    for (const subId of oneTimeSubs) {
      await this.unsubscribe(subId);
    }

    return message;
  }

  // ── History ─────────────────────────────────────────────────────

  /** Returns the message history for a topic. */
  getHistory(topicName: string, limit?: number): Message[] {
    const topic = this.topics.get(topicName);
    const maxLimit = limit ?? topic?.maxHistory ?? this.options.defaultMaxHistory;
    return this.history.getHistory(topicName, { limit: maxLimit });
  }

  /** Returns the internal history store (for testing/inspection). */
  getHistoryStore(): HistoryStore {
    return this.history;
  }

  // ── Pattern Matching ────────────────────────────────────────────

  /**
   * Finds all subscribed topic patterns that match the given concrete topic.
   * E.g., if someone subscribed to "user.*", and we publish to "user.created",
   * this returns ["user.*"].
   */
  private findPatternMatches(concreteTopic: string): string[] {
    const matches: string[] = [];
    for (const topicName of this.subscribers.keys()) {
      if (topicName === concreteTopic) continue; // skip direct match (handled separately)
      if (this.router.matchPattern(topicName, concreteTopic)) {
        matches.push(topicName);
      }
    }
    return matches;
  }

  // ── Utilities ───────────────────────────────────────────────────

  /** Removes all topics, subscribers, and history. */
  clear(): void {
    this.topics.clear();
    this.subscribers.clear();
    this.history.clear();
  }

  /** Returns the router instance (for testing). */
  getRouter(): TopicRouter {
    return this.router;
  }
}
