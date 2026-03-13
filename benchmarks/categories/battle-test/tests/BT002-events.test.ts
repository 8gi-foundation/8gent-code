import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let eventBus: any, retryHandler: any, dlq: any, backpressure: any;

beforeEach(async () => {
  try {
    eventBus = await import(path.join(WORK_DIR, "event-bus.ts"));
    retryHandler = await import(path.join(WORK_DIR, "retry-handler.ts"));
    dlq = await import(path.join(WORK_DIR, "dead-letter-queue.ts"));
    backpressure = await import(path.join(WORK_DIR, "backpressure.ts"));
  } catch {}
});

describe("EventBus", () => {
  it("emits and receives events", async () => {
    const EB = eventBus.EventBus || eventBus.default;
    const bus = new EB();
    let received: any = null;
    bus.on("test", (data: any) => { received = data; });
    await bus.emit("test", { value: 42 });
    expect(received).toEqual({ value: 42 });
  });

  it("once handler fires only once", async () => {
    const EB = eventBus.EventBus || eventBus.default;
    const bus = new EB();
    let count = 0;
    bus.once("ping", () => { count++; });
    await bus.emit("ping", {});
    await bus.emit("ping", {});
    expect(count).toBe(1);
  });

  it("unsubscribe stops handler", async () => {
    const EB = eventBus.EventBus || eventBus.default;
    const bus = new EB();
    let count = 0;
    const unsub = bus.on("test", () => { count++; });
    await bus.emit("test", {});
    unsub();
    await bus.emit("test", {});
    expect(count).toBe(1);
  });

  it("priority ordering works", async () => {
    const EB = eventBus.EventBus || eventBus.default;
    const bus = new EB();
    const order: number[] = [];
    bus.on("test", () => { order.push(1); }, { priority: 1 });
    bus.on("test", () => { order.push(10); }, { priority: 10 });
    bus.on("test", () => { order.push(5); }, { priority: 5 });
    await bus.emit("test", {});
    expect(order[0]).toBe(10);
    expect(order[2]).toBe(1);
  });

  it("filter option works", async () => {
    const EB = eventBus.EventBus || eventBus.default;
    const bus = new EB();
    let received = false;
    bus.on("test", () => { received = true; }, { filter: (d: any) => d.type === "match" });
    await bus.emit("test", { type: "nomatch" });
    expect(received).toBe(false);
    await bus.emit("test", { type: "match" });
    expect(received).toBe(true);
  });

  it("listenerCount and eventNames work", () => {
    const EB = eventBus.EventBus || eventBus.default;
    const bus = new EB();
    bus.on("a", () => {});
    bus.on("a", () => {});
    bus.on("b", () => {});
    expect(bus.listenerCount("a")).toBe(2);
    expect(bus.eventNames()).toContain("a");
    expect(bus.eventNames()).toContain("b");
  });

  it("emit returns result with delivered count", async () => {
    const EB = eventBus.EventBus || eventBus.default;
    const bus = new EB();
    bus.on("test", () => {});
    bus.on("test", () => {});
    const result = await bus.emit("test", {});
    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(0);
  });
});

describe("RetryHandler", () => {
  it("succeeds on first try", async () => {
    const RH = retryHandler.RetryHandler || retryHandler.default;
    const handler = new RH({ maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    const result = await handler.execute(async () => "ok");
    expect(result).toBe("ok");
  });

  it("retries and succeeds", async () => {
    const RH = retryHandler.RetryHandler || retryHandler.default;
    const handler = new RH({ maxRetries: 3, baseDelayMs: 10, maxDelayMs: 100 });
    let attempts = 0;
    const result = await handler.execute(async () => {
      attempts++;
      if (attempts < 3) throw new Error("not yet");
      return "finally";
    });
    expect(result).toBe("finally");
    expect(attempts).toBe(3);
  });

  it("throws after max retries", async () => {
    const RH = retryHandler.RetryHandler || retryHandler.default;
    const handler = new RH({ maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
    try {
      await handler.execute(async () => { throw new Error("fail"); });
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.message).toBeDefined();
    }
  });
});

describe("DeadLetterQueue", () => {
  it("enqueue and dequeue work", () => {
    const DLQ = dlq.DeadLetterQueue || dlq.default;
    const queue = new DLQ();
    const id = queue.enqueue("test.event", { foo: 1 }, new Error("failed"));
    expect(typeof id).toBe("string");
    expect(queue.size()).toBe(1);
    const entry = queue.dequeue();
    expect(entry).not.toBeNull();
    expect(entry.event).toBe("test.event");
    expect(queue.size()).toBe(0);
  });

  it("FIFO ordering", () => {
    const DLQ = dlq.DeadLetterQueue || dlq.default;
    const queue = new DLQ();
    queue.enqueue("first", {}, new Error("e1"));
    queue.enqueue("second", {}, new Error("e2"));
    expect(queue.dequeue()!.event).toBe("first");
    expect(queue.dequeue()!.event).toBe("second");
  });

  it("list returns entries", () => {
    const DLQ = dlq.DeadLetterQueue || dlq.default;
    const queue = new DLQ();
    queue.enqueue("a", {}, new Error("e"));
    queue.enqueue("b", {}, new Error("e"));
    queue.enqueue("c", {}, new Error("e"));
    const list = queue.list(2);
    expect(list.length).toBe(2);
  });

  it("purge removes old entries", () => {
    const DLQ = dlq.DeadLetterQueue || dlq.default;
    const queue = new DLQ();
    queue.enqueue("old", {}, new Error("e"));
    const removed = queue.purge(0); // purge everything
    expect(removed).toBe(1);
    expect(queue.size()).toBe(0);
  });
});

describe("BackpressureController", () => {
  it("allows concurrent requests up to limit", async () => {
    const BP = backpressure.BackpressureController || backpressure.default;
    const ctrl = new BP({ maxConcurrent: 2, maxQueueSize: 5 });
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 4 }, (_, i) =>
      ctrl.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 50));
        running--;
        return i;
      })
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3]);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("getStats returns correct values", async () => {
    const BP = backpressure.BackpressureController || backpressure.default;
    const ctrl = new BP({ maxConcurrent: 3, maxQueueSize: 10 });
    const stats = ctrl.getStats();
    expect(stats.maxConcurrent).toBe(3);
    expect(stats.maxQueue).toBe(10);
    expect(stats.running).toBe(0);
    expect(stats.queued).toBe(0);
  });
});
