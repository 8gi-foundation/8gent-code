/**
 * SD001 — Systems Debugging: Message Broker
 *
 * Tests a message broker system with 3 subtle bugs:
 *   1. Race condition in concurrent subscribe/unsubscribe (broker.ts)
 *   2. Memory leak in history store — no pruning (history.ts)
 *   3. Off-by-one in wildcard pattern matching (router.ts)
 *
 * The LLM must identify and fix all bugs while preserving correct behavior.
 *
 * WORK_DIR contains: types.ts, broker.ts, history.ts, router.ts
 * (all 4 files are copied from fixtures, LLM overwrites with fixed versions)
 */
import { describe, test, expect, beforeEach } from "bun:test";

const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error("WORK_DIR env var required");

// ── Dynamic imports from the LLM's fixed files ─────────────────────

const brokerMod = await import(`${workDir}/broker.ts`);
const historyMod = await import(`${workDir}/history.ts`);
const routerMod = await import(`${workDir}/router.ts`);

// Flexibly resolve exports
const MessageBroker =
  brokerMod.MessageBroker ?? brokerMod.Broker ?? brokerMod.default;
const HistoryStore =
  historyMod.HistoryStore ?? historyMod.History ?? historyMod.default;
const TopicRouter =
  routerMod.TopicRouter ?? routerMod.Router ?? routerMod.default;

if (!MessageBroker) {
  throw new Error("broker.ts must export MessageBroker, Broker, or default class");
}
if (!HistoryStore) {
  throw new Error("history.ts must export HistoryStore, History, or default class");
}
if (!TopicRouter) {
  throw new Error("router.ts must export TopicRouter, Router, or default class");
}

// ── Helpers ─────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════
// 1. BASIC FUNCTIONALITY (8 tests)
// ═══════════════════════════════════════════════════════════════════

describe("SD001: Basic Functionality", () => {
  let broker: InstanceType<typeof MessageBroker>;

  beforeEach(() => {
    broker = new MessageBroker({ awaitHandlers: true });
  });

  test("subscribe returns a subscription object", async () => {
    const sub = await broker.subscribe("test.topic", () => {});
    expect(sub).toBeDefined();
    expect(sub.id).toBeDefined();
    expect(sub.topic).toBe("test.topic");
  });

  test("publish delivers message to subscriber", async () => {
    const received: any[] = [];
    await broker.subscribe("orders", (msg: any) => {
      received.push(msg);
    });
    await broker.publish("orders", { item: "widget" });
    expect(received.length).toBe(1);
    expect(received[0].payload).toEqual({ item: "widget" });
    expect(received[0].topic).toBe("orders");
  });

  test("unsubscribe prevents future deliveries", async () => {
    const received: any[] = [];
    const sub = await broker.subscribe("events", (msg: any) => {
      received.push(msg);
    });
    await broker.publish("events", "first");
    expect(received.length).toBe(1);

    await broker.unsubscribe(sub.id);
    await broker.publish("events", "second");
    expect(received.length).toBe(1); // should NOT receive second
  });

  test("multiple subscribers all receive the message", async () => {
    const results: string[] = [];
    await broker.subscribe("multi", () => results.push("A"));
    await broker.subscribe("multi", () => results.push("B"));
    await broker.subscribe("multi", () => results.push("C"));

    await broker.publish("multi", "hello");
    expect(results.sort()).toEqual(["A", "B", "C"]);
  });

  test("message ordering is preserved within a topic", async () => {
    const received: number[] = [];
    await broker.subscribe("sequence", (msg: any) => {
      received.push(msg.payload);
    });

    await broker.publish("sequence", 1);
    await broker.publish("sequence", 2);
    await broker.publish("sequence", 3);

    expect(received).toEqual([1, 2, 3]);
  });

  test("history retrieval returns published messages", async () => {
    broker.createTopic("logs", 50);
    await broker.publish("logs", "entry-1");
    await broker.publish("logs", "entry-2");

    const history = broker.getHistory("logs");
    expect(history.length).toBe(2);
    expect(history[0].payload).toBe("entry-1");
    expect(history[1].payload).toBe("entry-2");
  });

  test("subscriber count reflects active subscriptions", async () => {
    await broker.subscribe("count.test", () => {});
    await broker.subscribe("count.test", () => {});
    expect(broker.subscriberCount("count.test")).toBe(2);
  });

  test("one-shot subscription fires only once", async () => {
    const received: any[] = [];
    await broker.subscribe(
      "once.topic",
      (msg: any) => received.push(msg.payload),
      true // once
    );

    await broker.publish("once.topic", "first");
    await broker.publish("once.topic", "second");

    expect(received).toEqual(["first"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. BUG 1 REGRESSION — Race Condition in Subscribe/Unsubscribe
// ═══════════════════════════════════════════════════════════════════

describe("SD001: Bug 1 — Concurrent Subscribe/Unsubscribe Race", () => {
  test("concurrent subscribes don't lose subscribers", async () => {
    const broker = new MessageBroker({ awaitHandlers: true });
    const topicName = "race.sub";
    broker.createTopic(topicName);

    // Enable lifecycle hook to introduce an async yield between
    // reading the subscriber array and writing the updated one.
    // This simulates real-world middleware (logging, validation, etc.)
    broker.onSubscribe = async () => {
      await Promise.resolve(); // yield to event loop
    };

    // Launch 50 concurrent subscribes — all should be retained
    const subscribeOps = Array.from({ length: 50 }, (_, i) =>
      broker.subscribe(topicName, () => {})
    );

    await Promise.all(subscribeOps);

    // All 50 subscribers must be present (no lost writes)
    expect(broker.subscriberCount(topicName)).toBe(50);
  });

  test("concurrent subscribe + unsubscribe doesn't lose persistent subscribers", async () => {
    const broker = new MessageBroker({ awaitHandlers: true });
    const topic = "race.mixed";
    broker.createTopic(topic);

    // Add lifecycle hooks to create interleaving opportunity
    broker.onSubscribe = async () => { await Promise.resolve(); };
    broker.onUnsubscribe = async () => { await Promise.resolve(); };

    // First, add 10 persistent subscribers sequentially (no race)
    const persistent: any[] = [];
    for (let i = 0; i < 10; i++) {
      persistent.push(await broker.subscribe(topic, () => {}));
    }

    // Now concurrently: add 20 temp subscribers and immediately unsubscribe them
    // Plus add 20 more persistent subscribers
    const tempOps = Array.from({ length: 20 }, async () => {
      const tmp = await broker.subscribe(topic, () => {});
      await broker.unsubscribe(tmp.id);
    });
    const persistOps = Array.from({ length: 20 }, () =>
      broker.subscribe(topic, () => {})
    );

    await Promise.all([...tempOps, ...persistOps]);

    // Should have 10 original + 20 new persistent = 30
    expect(broker.subscriberCount(topic)).toBe(30);
  });

  test("concurrent operations preserve message delivery", async () => {
    const broker = new MessageBroker({ awaitHandlers: true });
    const topic = "race.delivery";

    broker.onSubscribe = async () => { await Promise.resolve(); };
    broker.onUnsubscribe = async () => { await Promise.resolve(); };

    // Add 30 subscribers concurrently, each tracking deliveries
    const deliveryCounts = new Map<string, number>();
    const subs = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const id = `handler-${i}`;
        deliveryCounts.set(id, 0);
        return broker.subscribe(topic, () => {
          deliveryCounts.set(id, (deliveryCounts.get(id) ?? 0) + 1);
        });
      })
    );

    // Publish a message — all 30 should receive it
    await broker.publish(topic, "test-payload");

    const totalDeliveries = [...deliveryCounts.values()].reduce((a, b) => a + b, 0);
    expect(totalDeliveries).toBe(30);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. BUG 2 REGRESSION — Memory Leak in History Store
// ═══════════════════════════════════════════════════════════════════

describe("SD001: Bug 2 — History Memory Leak", () => {
  test("internal storage is pruned to maxHistory after many messages", () => {
    const store = new HistoryStore();
    const maxHistory = 10;

    // Publish 1000 messages
    for (let i = 0; i < 1000; i++) {
      store.addMessage(
        "leak.test",
        {
          id: `msg_${i}`,
          topic: "leak.test",
          payload: `payload-${i}`,
          timestamp: Date.now() + i,
        },
        maxHistory
      );
    }

    // The internal storage MUST be bounded, not 1000
    const internalSize = store.getInternalSize("leak.test");
    expect(internalSize).toBeLessThanOrEqual(maxHistory);

    // getHistory should return the most recent messages
    const history = store.getHistory("leak.test", { limit: maxHistory });
    expect(history.length).toBe(maxHistory);
    expect(history[history.length - 1].payload).toBe("payload-999");
  });

  test("total memory doesn't grow proportionally with message count", () => {
    const store = new HistoryStore();
    const maxHistory = 5;

    // Add 500 messages across 10 topics
    for (let t = 0; t < 10; t++) {
      for (let i = 0; i < 50; i++) {
        store.addMessage(
          `topic-${t}`,
          {
            id: `msg_${t}_${i}`,
            topic: `topic-${t}`,
            payload: { data: `value-${i}` },
            timestamp: Date.now() + i,
          },
          maxHistory
        );
      }
    }

    // Total messages in storage should be bounded: 10 topics * 5 max = 50
    const totalStored = store.totalMessages();
    expect(totalStored).toBeLessThanOrEqual(10 * maxHistory); // 50, not 500
  });

  test("getHistory returns correct data after pruning", () => {
    const store = new HistoryStore();
    const maxHistory = 3;

    for (let i = 0; i < 20; i++) {
      store.addMessage(
        "prune.check",
        {
          id: `msg_${i}`,
          topic: "prune.check",
          payload: i,
          timestamp: 1000 + i,
        },
        maxHistory
      );
    }

    const history = store.getHistory("prune.check", { limit: maxHistory });
    expect(history.length).toBe(3);
    // Should be the last 3 messages: 17, 18, 19
    expect(history[0].payload).toBe(17);
    expect(history[1].payload).toBe(18);
    expect(history[2].payload).toBe(19);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. BUG 3 REGRESSION — Off-by-One in Pattern Matching
// ═══════════════════════════════════════════════════════════════════

describe("SD001: Bug 3 — Wildcard Pattern Matching", () => {
  let router: InstanceType<typeof TopicRouter>;

  beforeEach(() => {
    router = new TopicRouter();
  });

  test("user.* matches user. (empty suffix — zero characters)", () => {
    // CONTRACT: * matches ZERO or more characters
    expect(router.matchPattern("user.*", "user.")).toBe(true);
  });

  test("user.* matches user.created", () => {
    expect(router.matchPattern("user.*", "user.created")).toBe(true);
  });

  test("user.* matches user.updated", () => {
    expect(router.matchPattern("user.*", "user.updated")).toBe(true);
  });

  test("user.* matches user.profile.updated (multi-segment)", () => {
    expect(router.matchPattern("user.*", "user.profile.updated")).toBe(true);
  });

  test("*.event matches .event (empty prefix — zero characters)", () => {
    // CONTRACT: * matches ZERO or more characters
    expect(router.matchPattern("*.event", ".event")).toBe(true);
  });

  test("*.event matches system.event", () => {
    expect(router.matchPattern("*.event", "system.event")).toBe(true);
  });

  test("* matches any topic (universal wildcard)", () => {
    expect(router.matchPattern("*", "anything")).toBe(true);
    expect(router.matchPattern("*", "user.created")).toBe(true);
    expect(router.matchPattern("*", "")).toBe(true);
    expect(router.matchPattern("*", "a.b.c.d")).toBe(true);
  });

  test("exact match still works", () => {
    expect(router.matchPattern("orders", "orders")).toBe(true);
    expect(router.matchPattern("orders", "orders.new")).toBe(false);
  });

  test("user.* does NOT match user (no dot)", () => {
    // "user.*" requires the "user." prefix
    expect(router.matchPattern("user.*", "user")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. NO REGRESSIONS
// ═══════════════════════════════════════════════════════════════════

describe("SD001: No Regressions", () => {
  let broker: InstanceType<typeof MessageBroker>;

  beforeEach(() => {
    broker = new MessageBroker({ awaitHandlers: true });
  });

  test("message ordering preserved across subscribers", async () => {
    const order: number[] = [];
    await broker.subscribe("order.test", (msg: any) => order.push(msg.payload));

    for (let i = 0; i < 10; i++) {
      await broker.publish("order.test", i);
    }

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("unsubscribe actually removes handler — no ghost deliveries", async () => {
    const received: string[] = [];
    const sub = await broker.subscribe("ghost.test", () => {
      received.push("delivered");
    });

    await broker.publish("ghost.test", "before");
    expect(received.length).toBe(1);

    const removed = await broker.unsubscribe(sub.id);
    expect(removed).toBe(true);

    await broker.publish("ghost.test", "after");
    expect(received.length).toBe(1); // still 1 — no ghost delivery
  });

  test("clear() resets all state", async () => {
    await broker.subscribe("clear.test", () => {});
    await broker.publish("clear.test", "data");

    broker.clear();

    expect(broker.subscriberCount("clear.test")).toBe(0);
    expect(broker.getHistory("clear.test").length).toBe(0);
    expect(broker.getTopicNames().length).toBe(0);
  });

  test("publish to topic with no subscribers doesn't throw", async () => {
    // Should complete without error
    const msg = await broker.publish("empty.topic", "lonely message");
    expect(msg).toBeDefined();
    expect(msg.id).toBeDefined();
  });
});
