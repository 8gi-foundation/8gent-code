import type { BenchmarkDefinition } from "../../types";

export const systemsDebuggingBenchmark: BenchmarkDefinition[] = [
  {
    id: "SD001",
    category: "bug-fixing",
    title: "Systems Debugging — Message Broker with 3 Subtle Bugs",
    difficulty: "hard",
    prompt: `You are given a message broker system with pub/sub, message history, and wildcard topic routing. The system has **3 subtle bugs** that cause failures under specific conditions. Your task is to find and fix all bugs while preserving correct behavior.

## System Overview

The system consists of 4 files. You must output ALL 4 files (even the bug-free types.ts).

### 1. types.ts — Shared types (NO BUGS)

\`\`\`typescript
// Message, Subscription, Topic, BrokerOptions, HistoryOptions
// MessageHandler = (message: Message) => void | Promise<void>
// See the full types below — do NOT change the interfaces.
\`\`\`

### 2. broker.ts — Message broker with pub/sub

- subscribe(topic, handler, once?) → Promise<Subscription>
- unsubscribe(subscriptionId) → Promise<boolean>
- publish(topic, payload, metadata?) → Promise<Message>
- Lifecycle hooks: onSubscribe, onUnsubscribe (async callbacks)
- Copy-on-write subscriber arrays for concurrent safety
- **BUG HINT**: When lifecycle hooks are present, concurrent operations on the same topic can lose subscribers. The read-then-await-then-write pattern creates a window where multiple operations read the same snapshot and overwrite each other's changes.

### 3. history.ts — Message history store

- addMessage(topic, message, maxHistory) — stores a message
- getHistory(topic, options?) — retrieves recent messages
- getInternalSize(topic) — returns actual internal array length
- totalMessages() — returns total messages across all topics
- **BUG HINT**: The store has a maxHistory parameter but never actually prunes old messages. The getHistory() method masks this by slicing the return value, but the internal array grows forever — a classic memory leak.

### 4. router.ts — Topic pattern matching with wildcards

- matchPattern(pattern, topic) → boolean
- Supports: \`*\` (matches everything), \`prefix.*\`, \`*.suffix\`
- CONTRACT: \`*\` matches ZERO or more characters
- **BUG HINT**: The wildcard matching requires the wildcard part to match "one or more" characters instead of "zero or more". This means \`user.*\` doesn't match \`user.\` (empty suffix) even though the documented contract says \`*\` matches zero or more characters.

## The Buggy Code

### types.ts
\`\`\`typescript // types.ts
export interface Message {
  id: string;
  topic: string;
  payload: unknown;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Subscription {
  id: string;
  topic: string;
  handler: MessageHandler;
  once: boolean;
  createdAt: number;
}

export type MessageHandler = (message: Message) => void | Promise<void>;

export interface Topic {
  name: string;
  maxHistory: number;
  replayOnSubscribe: boolean;
  createdAt: number;
}

export interface BrokerOptions {
  defaultMaxHistory: number;
  enablePatternMatching: boolean;
  awaitHandlers: boolean;
}

export interface HistoryOptions {
  limit?: number;
  since?: number;
  until?: number;
}
\`\`\`

### broker.ts
\`\`\`typescript // broker.ts
import type { Message, Subscription, MessageHandler, Topic, BrokerOptions } from "./types";
import { HistoryStore } from "./history";
import { TopicRouter } from "./router";

let _subIdCounter = 0;
function nextSubId(): string {
  return \`sub_\${++_subIdCounter}_\${Date.now().toString(36)}\`;
}

let _msgIdCounter = 0;
function nextMsgId(): string {
  return \`msg_\${++_msgIdCounter}_\${Date.now().toString(36)}\`;
}

export type LifecycleHook = (topicName: string, subscriptionId: string) => void | Promise<void>;

export class MessageBroker {
  private topics = new Map<string, Topic>();
  private subscribers = new Map<string, Subscription[]>();
  private history: HistoryStore;
  private router: TopicRouter;
  private options: BrokerOptions;

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

  createTopic(name: string, maxHistory?: number, replayOnSubscribe = false): Topic {
    if (this.topics.has(name)) return this.topics.get(name)!;
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

  getTopic(name: string): Topic | null { return this.topics.get(name) ?? null; }
  getTopicNames(): string[] { return [...this.topics.keys()]; }

  async subscribe(topicName: string, handler: MessageHandler, once = false): Promise<Subscription> {
    if (!this.topics.has(topicName)) this.createTopic(topicName);

    const subscription: Subscription = {
      id: nextSubId(), topic: topicName, handler, once, createdAt: Date.now(),
    };

    // Copy-on-write: read current list
    const current = this.subscribers.get(topicName) ?? [];

    // Await lifecycle hook (allows middleware-like extension)
    if (this.onSubscribe) {
      await this.onSubscribe(topicName, subscription.id);
    }

    // Append and replace
    const updated = [...current, subscription];
    this.subscribers.set(topicName, updated);

    return subscription;
  }

  async unsubscribe(subscriptionId: string): Promise<boolean> {
    for (const [topicName, subs] of this.subscribers.entries()) {
      const idx = subs.findIndex((s) => s.id === subscriptionId);
      if (idx !== -1) {
        const currentSubs = this.subscribers.get(topicName) ?? [];

        if (this.onUnsubscribe) {
          await this.onUnsubscribe(topicName, subscriptionId);
        }

        const updated = currentSubs.filter((s) => s.id !== subscriptionId);
        this.subscribers.set(topicName, updated);
        return true;
      }
    }
    return false;
  }

  subscriberCount(topicName: string): number {
    return (this.subscribers.get(topicName) ?? []).length;
  }

  async publish(topicName: string, payload: unknown, metadata?: Record<string, unknown>): Promise<Message> {
    if (!this.topics.has(topicName)) this.createTopic(topicName);

    const message: Message = {
      id: nextMsgId(), topic: topicName, payload, timestamp: Date.now(), metadata,
    };

    const topic = this.topics.get(topicName)!;
    this.history.addMessage(topicName, message, topic.maxHistory);

    const directSubs = this.subscribers.get(topicName) ?? [];
    const matchedTopics = this.options.enablePatternMatching
      ? this.findPatternMatches(topicName) : [];

    const allSubs = [
      ...directSubs,
      ...matchedTopics.flatMap((t) => this.subscribers.get(t) ?? []),
    ];

    const oneTimeSubs: string[] = [];
    const deliveries = allSubs.map(async (sub) => {
      try {
        if (this.options.awaitHandlers) await sub.handler(message);
        else sub.handler(message);
        if (sub.once) oneTimeSubs.push(sub.id);
      } catch (err) {
        console.error(\`Subscriber \${sub.id} error:\`, err);
      }
    });

    await Promise.all(deliveries);
    for (const subId of oneTimeSubs) await this.unsubscribe(subId);

    return message;
  }

  getHistory(topicName: string, limit?: number): Message[] {
    const topic = this.topics.get(topicName);
    const maxLimit = limit ?? topic?.maxHistory ?? this.options.defaultMaxHistory;
    return this.history.getHistory(topicName, { limit: maxLimit });
  }

  getHistoryStore(): HistoryStore { return this.history; }

  private findPatternMatches(concreteTopic: string): string[] {
    const matches: string[] = [];
    for (const topicName of this.subscribers.keys()) {
      if (topicName === concreteTopic) continue;
      if (this.router.matchPattern(topicName, concreteTopic)) matches.push(topicName);
    }
    return matches;
  }

  clear(): void {
    this.topics.clear();
    this.subscribers.clear();
    this.history.clear();
  }

  getRouter(): TopicRouter { return this.router; }
}
\`\`\`

### history.ts
\`\`\`typescript // history.ts
import type { Message, HistoryOptions } from "./types";

export class HistoryStore {
  private store = new Map<string, Message[]>();

  addMessage(topic: string, message: Message, maxHistory: number): void {
    if (!this.store.has(topic)) this.store.set(topic, []);
    const messages = this.store.get(topic)!;
    messages.push(message);
    // maxHistory is used by getHistory() for slicing
  }

  getHistory(topic: string, options?: HistoryOptions): Message[] {
    const messages = this.store.get(topic) ?? [];
    let result = [...messages];

    if (options?.since !== undefined) result = result.filter((m) => m.timestamp >= options.since!);
    if (options?.until !== undefined) result = result.filter((m) => m.timestamp <= options.until!);

    const limit = options?.limit;
    if (limit !== undefined && limit > 0 && result.length > limit) {
      result = result.slice(-limit);
    }

    return result;
  }

  getInternalSize(topic: string): number {
    return (this.store.get(topic) ?? []).length;
  }

  totalMessages(): number {
    let total = 0;
    for (const msgs of this.store.values()) total += msgs.length;
    return total;
  }

  clear(): void { this.store.clear(); }
}
\`\`\`

### router.ts
\`\`\`typescript // router.ts
export class TopicRouter {
  matchPattern(pattern: string, topic: string): boolean {
    if (pattern === topic) return true;
    if (pattern === "*") return true;
    if (!pattern.includes("*")) return false;

    const starIndex = pattern.indexOf("*");
    const prefix = pattern.substring(0, starIndex);
    const suffix = pattern.substring(starIndex + 1);

    if (prefix.length + suffix.length > topic.length) return false;

    const matchesPrefix = topic.startsWith(prefix);
    const matchesSuffix = suffix === "" || topic.endsWith(suffix);

    if (matchesPrefix && matchesSuffix) {
      const wildcardPart = topic.substring(prefix.length, topic.length - (suffix.length || 0));
      return wildcardPart.length > 0;  // BUG: should be >= 0 (zero or more)
    }

    return false;
  }

  filterTopics(pattern: string, topics: string[]): string[] {
    return topics.filter((t) => this.matchPattern(pattern, t));
  }

  findMatchingPatterns(topic: string, patterns: string[]): string[] {
    return patterns.filter((p) => this.matchPattern(p, topic));
  }
}
\`\`\`

## Output Format

Output ALL 4 fixed files using these exact markers:

\`\`\`typescript // types.ts
// (copy as-is — no changes needed)
\`\`\`

\`\`\`typescript // broker.ts
// your fixed broker code
\`\`\`

\`\`\`typescript // history.ts
// your fixed history code
\`\`\`

\`\`\`typescript // router.ts
// your fixed router code
\`\`\`

## Summary of Bugs to Fix

1. **broker.ts — Race condition**: The read-await-write pattern in subscribe/unsubscribe allows concurrent operations to clobber each other. Fix: ensure the subscriber list is read AFTER the await, not before.
2. **history.ts — Memory leak**: addMessage() never prunes old messages. Fix: trim the array to maxHistory after pushing.
3. **router.ts — Off-by-one**: wildcardPart.length > 0 should be >= 0 to match the "zero or more" contract.`,
    keywords: [
      "subscribe", "unsubscribe", "publish", "MessageBroker", "LifecycleHook",
      "onSubscribe", "onUnsubscribe", "copy-on-write", "concurrent",
      "HistoryStore", "addMessage", "maxHistory", "splice", "slice", "prune",
      "TopicRouter", "matchPattern", "wildcard", ">=",
      "Promise", "async", "await",
    ],
    keywordThreshold: 12,
    testExecution: true,
    testFile: "autoresearch/tests/SD001-systems-debugging.test.ts",
    timeoutMs: 30000,
    multiFile: true,
    fixtures: [
      "fixtures/broker-system/types.ts",
      "fixtures/broker-system/broker.ts",
      "fixtures/broker-system/history.ts",
      "fixtures/broker-system/router.ts",
    ],
  },
];
