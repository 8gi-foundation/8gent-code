/**
 * FS002 — Task Queue with Workers, Retry, and Dead Letter Queue
 *
 * WORK_DIR contains: types.ts, queue.ts, worker.ts, scheduler.ts (all LLM-generated)
 */
import { describe, test, expect, beforeEach } from "bun:test";

const workDir = process.env.WORK_DIR;
if (!workDir) throw new Error("WORK_DIR env var required");

// Import LLM-generated modules
const queueMod = await import(`${workDir}/queue.ts`);
const workerMod = await import(`${workDir}/worker.ts`);
const schedulerMod = await import(`${workDir}/scheduler.ts`);

const QueueClass = queueMod.default ?? queueMod.TaskQueue ?? queueMod.Queue;
const WorkerClass = workerMod.default ?? workerMod.Worker ?? workerMod.TaskWorker;
const createTask: Function =
  schedulerMod.createTask ?? schedulerMod.default?.createTask;
const createBatch: Function | undefined = schedulerMod.createBatch;
const schedule: Function | undefined = schedulerMod.schedule;

if (!QueueClass) throw new Error("queue.ts must export TaskQueue, Queue, or default");
if (!WorkerClass) throw new Error("worker.ts must export Worker, TaskWorker, or default");
if (!createTask) throw new Error("scheduler.ts must export createTask");

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("FS002: Task Queue System", () => {
  let queue: InstanceType<typeof QueueClass>;

  beforeEach(() => {
    queue = new QueueClass();
  });

  // ── Basic Queue Operations ──────────────────────────────────────

  test("enqueue and dequeue a task", () => {
    const task = createTask("email", { to: "a@b.com" });
    queue.enqueue(task);
    const dequeued = queue.dequeue();
    expect(dequeued).toBeDefined();
    expect(dequeued.type ?? dequeued.task?.type).toBe("email");
  });

  test("dequeue returns null/undefined when empty", () => {
    const result = queue.dequeue();
    expect(result == null).toBe(true);
  });

  test("higher priority tasks dequeue first", () => {
    const low = createTask("low", {}, { priority: 1 });
    const high = createTask("high", {}, { priority: 10 });
    const mid = createTask("mid", {}, { priority: 5 });

    queue.enqueue(low);
    queue.enqueue(high);
    queue.enqueue(mid);

    const first = queue.dequeue();
    expect(first.type ?? first.task?.type).toBe("high");
    const second = queue.dequeue();
    expect(second.type ?? second.task?.type).toBe("mid");
  });

  // ── Task Lifecycle ──────────────────────────────────────────────

  test("complete marks task as completed", () => {
    const task = createTask("work", { x: 1 });
    queue.enqueue(task);
    const dequeued = queue.dequeue();
    const id = dequeued.id ?? dequeued.task?.id;
    queue.complete(id, { output: "done" });

    const stats = queue.stats();
    expect(stats.completed).toBe(1);
    expect(stats.processing).toBe(0);
  });

  test("fail with retries re-enqueues task", () => {
    const task = createTask("retry-me", {}, { maxRetries: 3 });
    queue.enqueue(task);
    const dequeued = queue.dequeue();
    const id = dequeued.id ?? dequeued.task?.id;

    queue.fail(id, "temporary error");

    const stats = queue.stats();
    // Should be back in pending, not dead
    expect(stats.pending).toBe(1);
    expect(stats.dead).toBe(0);
  });

  test("fail after max retries moves to DLQ", () => {
    const task = createTask("doomed", {}, { maxRetries: 1 });
    queue.enqueue(task);

    // Attempt 1
    let dequeued = queue.dequeue();
    let id = dequeued.id ?? dequeued.task?.id;
    queue.fail(id, "error 1");

    // Attempt 2 (should be re-enqueued)
    dequeued = queue.dequeue();
    id = dequeued.id ?? dequeued.task?.id;
    queue.fail(id, "error 2");

    const stats = queue.stats();
    expect(stats.dead).toBe(1);
    expect(stats.pending).toBe(0);

    const dlq = queue.getDeadLetterQueue();
    expect(dlq.length).toBe(1);
  });

  // ── Stats ───────────────────────────────────────────────────────

  test("stats tracks all statuses correctly", () => {
    queue.enqueue(createTask("a", {}));
    queue.enqueue(createTask("b", {}));
    queue.enqueue(createTask("c", {}));

    queue.dequeue(); // one in processing

    const stats = queue.stats();
    expect(stats.pending).toBe(2);
    expect(stats.processing).toBe(1);
    expect(stats.completed).toBe(0);
  });

  // ── Worker Processing ───────────────────────────────────────────

  test("worker processes tasks via handlers", async () => {
    const results: string[] = [];
    const handlers = {
      greet: async (payload: any) => {
        results.push(`Hello ${payload.name}`);
        return `greeted ${payload.name}`;
      },
    };

    const worker = new WorkerClass(queue, handlers);

    queue.enqueue(createTask("greet", { name: "Alice" }));
    queue.enqueue(createTask("greet", { name: "Bob" }));

    worker.start();
    await delay(300);
    worker.stop();

    expect(results).toContain("Hello Alice");
    expect(results).toContain("Hello Bob");
  });

  test("worker handles missing handler gracefully", async () => {
    const handlers = {};
    const worker = new WorkerClass(queue, handlers);

    queue.enqueue(createTask("unknown-type", {}, { maxRetries: 0 }));

    worker.start();
    await delay(200);
    worker.stop();

    const stats = queue.stats();
    // Should have failed/gone to DLQ, not crashed
    expect(stats.dead).toBeGreaterThanOrEqual(1);
  });

  test("worker retries failed tasks", async () => {
    let attempts = 0;
    const handlers = {
      flaky: async () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return "success";
      },
    };

    const worker = new WorkerClass(queue, handlers);

    queue.enqueue(createTask("flaky", {}, { maxRetries: 5 }));

    worker.start();
    await delay(500);
    worker.stop();

    expect(attempts).toBeGreaterThanOrEqual(3);
    const stats = queue.stats();
    expect(stats.completed).toBe(1);
  });

  // ── Scheduler ───────────────────────────────────────────────────

  test("createTask returns a valid task object", () => {
    const task = createTask("test", { data: 42 });
    expect(task.type ?? task.task?.type).toBe("test");
    expect(task.id ?? task.task?.id).toBeDefined();
  });

  test("scheduled task executes after delay", async () => {
    if (!schedule) return; // optional

    const processed: string[] = [];
    const handlers = {
      delayed: async (p: any) => {
        processed.push(p.msg);
      },
    };

    const worker = new WorkerClass(queue, handlers);
    worker.start();

    schedule(queue, "delayed", { msg: "later" }, 100);

    // Should not be processed immediately
    await delay(50);
    expect(processed.length).toBe(0);

    // Should be processed after delay
    await delay(200);
    worker.stop();
    expect(processed).toContain("later");
  });
});
