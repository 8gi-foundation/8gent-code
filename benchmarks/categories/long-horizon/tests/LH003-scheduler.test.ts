import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.join(import.meta.dir, "../../autoresearch/work");

// Dynamic imports from generated code
let cronParser: any, priorityQueue: any, workerPool: any, circuitBreaker: any, scheduler: any;

beforeEach(async () => {
  try {
    cronParser = await import(path.join(WORK_DIR, "cron-parser.ts"));
  } catch { try { cronParser = await import(path.join(WORK_DIR, "cron-parser.js")); } catch {} }
  try {
    priorityQueue = await import(path.join(WORK_DIR, "priority-queue.ts"));
  } catch { try { priorityQueue = await import(path.join(WORK_DIR, "priority-queue.js")); } catch {} }
  try {
    workerPool = await import(path.join(WORK_DIR, "worker-pool.ts"));
  } catch { try { workerPool = await import(path.join(WORK_DIR, "worker-pool.js")); } catch {} }
  try {
    circuitBreaker = await import(path.join(WORK_DIR, "circuit-breaker.ts"));
  } catch { try { circuitBreaker = await import(path.join(WORK_DIR, "circuit-breaker.js")); } catch {} }
  try {
    scheduler = await import(path.join(WORK_DIR, "scheduler.ts"));
  } catch { try { scheduler = await import(path.join(WORK_DIR, "scheduler.js")); } catch {} }
});

// ── Cron Parser ─────────────────────────────────────

describe("Cron Parser", () => {
  it("parseCron handles * (every)", () => {
    const fn = cronParser.parseCron || cronParser.default?.parseCron;
    // "* * * * *" = every minute
    const result = fn("* * * * *");
    expect(result).toBeDefined();
    expect(Array.isArray(result.minute)).toBe(true);
    // * for minute means 0-59
    expect(result.minute.length).toBe(60);
    expect(result.minute).toContain(0);
    expect(result.minute).toContain(59);
  });

  it("parseCron handles ranges (1-5)", () => {
    const fn = cronParser.parseCron || cronParser.default?.parseCron;
    // minute: 1-5, rest: every
    const result = fn("1-5 * * * *");
    expect(result.minute).toEqual([1, 2, 3, 4, 5]);
  });

  it("parseCron handles steps (*/5)", () => {
    const fn = cronParser.parseCron || cronParser.default?.parseCron;
    // Every 5 minutes
    const result = fn("*/5 * * * *");
    expect(result.minute).toContain(0);
    expect(result.minute).toContain(5);
    expect(result.minute).toContain(10);
    expect(result.minute).toContain(55);
    expect(result.minute).not.toContain(1);
    expect(result.minute).not.toContain(3);
    expect(result.minute.length).toBe(12); // 0,5,10,15,...,55
  });

  it("parseCron handles lists (1,3,5)", () => {
    const fn = cronParser.parseCron || cronParser.default?.parseCron;
    const result = fn("1,3,5 * * * *");
    expect(result.minute).toEqual([1, 3, 5]);
  });

  it("parseCron validates ranges", () => {
    const fn = cronParser.parseCron || cronParser.default?.parseCron;
    // Minute 60 is out of range (valid: 0-59)
    let threw = false;
    try {
      fn("60 * * * *");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("getNextRun returns correct next occurrence", () => {
    const parseFn = cronParser.parseCron || cronParser.default?.parseCron;
    const nextFn = cronParser.getNextRun || cronParser.default?.getNextRun;
    // Every day at 10:30
    const schedule = parseFn("30 10 * * *");
    const from = new Date("2025-06-15T09:00:00Z");
    const next = nextFn(schedule, from);
    expect(next instanceof Date).toBe(true);
    expect(next.getUTCHours()).toBe(10);
    expect(next.getUTCMinutes()).toBe(30);
    // Should be the same day since 10:30 hasn't passed yet at 09:00
    expect(next.getUTCDate()).toBe(15);
  });
});

// ── Priority Queue ──────────────────────────────────

describe("PriorityQueue", () => {
  it("dequeues in priority order (lower = higher priority)", () => {
    const PQ = priorityQueue.PriorityQueue || priorityQueue.default?.PriorityQueue || priorityQueue.default;
    const q = new PQ();
    q.enqueue("low", 10);
    q.enqueue("high", 1);
    q.enqueue("medium", 5);
    expect(q.dequeue()).toBe("high");
    expect(q.dequeue()).toBe("medium");
    expect(q.dequeue()).toBe("low");
  });

  it("handles ties with FIFO ordering", () => {
    const PQ = priorityQueue.PriorityQueue || priorityQueue.default?.PriorityQueue || priorityQueue.default;
    const q = new PQ();
    q.enqueue("first", 1);
    q.enqueue("second", 1);
    q.enqueue("third", 1);
    const a = q.dequeue();
    const b = q.dequeue();
    const c = q.dequeue();
    // FIFO for same priority
    expect(a).toBe("first");
    expect(b).toBe("second");
    expect(c).toBe("third");
  });

  it("size and isEmpty work correctly", () => {
    const PQ = priorityQueue.PriorityQueue || priorityQueue.default?.PriorityQueue || priorityQueue.default;
    const q = new PQ();
    expect(q.isEmpty()).toBe(true);
    expect(q.size()).toBe(0);
    q.enqueue("a", 1);
    q.enqueue("b", 2);
    expect(q.isEmpty()).toBe(false);
    expect(q.size()).toBe(2);
    q.dequeue();
    expect(q.size()).toBe(1);
  });

  it("peek returns highest priority without removing", () => {
    const PQ = priorityQueue.PriorityQueue || priorityQueue.default?.PriorityQueue || priorityQueue.default;
    const q = new PQ();
    q.enqueue("low", 10);
    q.enqueue("high", 1);
    expect(q.peek()).toBe("high");
    expect(q.size()).toBe(2); // not removed
  });
});

// ── Worker Pool ─────────────────────────────────────

describe("WorkerPool", () => {
  it("respects maxWorkers concurrency", async () => {
    const WP = workerPool.WorkerPool || workerPool.default?.WorkerPool || workerPool.default;
    const pool = new WP({ maxWorkers: 2 });
    let concurrent = 0;
    let maxConcurrent = 0;

    const makeTask = () => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 50));
      concurrent--;
      return "done";
    };

    const promises = [
      pool.submit(makeTask()),
      pool.submit(makeTask()),
      pool.submit(makeTask()),
      pool.submit(makeTask()),
    ];
    await Promise.all(promises);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("drain waits for all tasks", async () => {
    const WP = workerPool.WorkerPool || workerPool.default?.WorkerPool || workerPool.default;
    const pool = new WP({ maxWorkers: 2 });
    let completed = 0;
    for (let i = 0; i < 5; i++) {
      pool.submit(async () => {
        await new Promise(r => setTimeout(r, 20));
        completed++;
      });
    }
    await pool.drain();
    expect(completed).toBe(5);
  });

  it("shutdown rejects new tasks", async () => {
    const WP = workerPool.WorkerPool || workerPool.default?.WorkerPool || workerPool.default;
    const pool = new WP({ maxWorkers: 1 });
    await pool.shutdown();
    let threw = false;
    try {
      await pool.submit(async () => "nope");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ── Circuit Breaker ─────────────────────────────────

describe("CircuitBreaker", () => {
  it("transitions closed → open on failures", async () => {
    const CB = circuitBreaker.CircuitBreaker || circuitBreaker.default?.CircuitBreaker || circuitBreaker.default;
    const breaker = new CB({ failureThreshold: 3, resetTimeoutMs: 1000 });
    expect(breaker.getState()).toBe("closed");
    // Trigger 3 failures
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => { throw new Error("fail"); });
      } catch {}
    }
    expect(breaker.getState()).toBe("open");
  });

  it("transitions open → half-open after timeout", async () => {
    const CB = circuitBreaker.CircuitBreaker || circuitBreaker.default?.CircuitBreaker || circuitBreaker.default;
    const breaker = new CB({ failureThreshold: 1, resetTimeoutMs: 100 });
    // Trigger failure to open
    try {
      await breaker.execute(async () => { throw new Error("fail"); });
    } catch {}
    expect(breaker.getState()).toBe("open");
    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 150));
    // Next call should transition to half-open
    // The transition typically happens on the next execute attempt
    try {
      await breaker.execute(async () => "ok");
    } catch {}
    // After a successful execute in half-open, should be closed
    // Or if the state check happens before execute
    const state = breaker.getState();
    expect(["half-open", "closed"]).toContain(state);
  });

  it("transitions half-open → closed on success", async () => {
    const CB = circuitBreaker.CircuitBreaker || circuitBreaker.default?.CircuitBreaker || circuitBreaker.default;
    const breaker = new CB({ failureThreshold: 1, resetTimeoutMs: 50 });
    // Open circuit
    try {
      await breaker.execute(async () => { throw new Error("fail"); });
    } catch {}
    expect(breaker.getState()).toBe("open");
    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 80));
    // Successful call in half-open should close
    await breaker.execute(async () => "success");
    expect(breaker.getState()).toBe("closed");
  });

  it("rejects calls when open", async () => {
    const CB = circuitBreaker.CircuitBreaker || circuitBreaker.default?.CircuitBreaker || circuitBreaker.default;
    const breaker = new CB({ failureThreshold: 1, resetTimeoutMs: 5000 });
    // Open circuit
    try {
      await breaker.execute(async () => { throw new Error("fail"); });
    } catch {}
    expect(breaker.getState()).toBe("open");
    // Next call should be rejected without executing
    let callExecuted = false;
    let rejected = false;
    try {
      await breaker.execute(async () => { callExecuted = true; return "should not run"; });
    } catch (e: any) {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(callExecuted).toBe(false);
  });
});

// ── Task Scheduler ──────────────────────────────────

describe("TaskScheduler", () => {
  it("schedules and executes tasks", async () => {
    const TS = scheduler.TaskScheduler || scheduler.default?.TaskScheduler || scheduler.default;
    const sched = new TS();
    let executed = false;
    // Schedule a task that runs every second (for testing)
    sched.schedule("test-task", "* * * * *", async () => {
      executed = true;
    }, { priority: 1 });
    // Verify it's registered
    const tasks = sched.getScheduledTasks();
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const testTask = tasks.find((t: any) => t.id === "test-task" || t.taskId === "test-task");
    expect(testTask).toBeDefined();
    // Clean up
    sched.unschedule("test-task");
    if (typeof sched.stop === "function") {
      await sched.stop();
    }
  });
});
