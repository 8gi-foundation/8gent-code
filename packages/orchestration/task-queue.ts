/**
 * TaskQueue - Priority-based task queue with concurrency limit, retry with backoff, and event emitter.
 * Zero external dependencies.
 */

export type TaskState = "pending" | "running" | "done" | "failed" | "cancelled";

export type TaskPriority = 1 | 2 | 3 | 4 | 5; // 1 = highest, 5 = lowest

export interface TaskOptions {
  priority?: TaskPriority;
  maxRetries?: number;
  retryBaseMs?: number; // base delay in ms for exponential backoff
  timeoutMs?: number;   // optional per-task timeout
  id?: string;
}

export interface Task<T = unknown> {
  id: string;
  priority: TaskPriority;
  state: TaskState;
  retries: number;
  maxRetries: number;
  retryBaseMs: number;
  timeoutMs: number | undefined;
  createdAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  error: Error | undefined;
  result: T | undefined;
  fn: () => Promise<T>;
}

export type QueueEvent =
  | { type: "enqueued"; task: Task }
  | { type: "started"; task: Task }
  | { type: "done"; task: Task }
  | { type: "failed"; task: Task }
  | { type: "retry"; task: Task; attempt: number; delayMs: number }
  | { type: "cancelled"; task: Task }
  | { type: "drained" };

type EventListener = (event: QueueEvent) => void;

let _idCounter = 0;
function nextId(): string {
  return `task-${Date.now()}-${++_idCounter}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TaskQueueOptions {
  concurrency?: number; // default 4
}

export class TaskQueue {
  private _concurrency: number;
  private _running = 0;
  private _queue: Task[] = [];
  private _tasks: Map<string, Task> = new Map();
  private _listeners: EventListener[] = [];
  private _stopped = false;

  constructor(options: TaskQueueOptions = {}) {
    this._concurrency = Math.max(1, options.concurrency ?? 4);
  }

  // -- Event emitter --

  on(listener: EventListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  private _emit(event: QueueEvent): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // swallow listener errors
      }
    }
  }

  // -- Enqueue --

  enqueue<T>(fn: () => Promise<T>, options: TaskOptions = {}): Task<T> {
    if (this._stopped) {
      throw new Error("TaskQueue is stopped");
    }

    const task: Task<T> = {
      id: options.id ?? nextId(),
      priority: options.priority ?? 3,
      state: "pending",
      retries: 0,
      maxRetries: options.maxRetries ?? 3,
      retryBaseMs: options.retryBaseMs ?? 500,
      timeoutMs: options.timeoutMs,
      createdAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      result: undefined,
      fn: fn as () => Promise<unknown>,
    } as unknown as Task<T>;

    this._tasks.set(task.id, task as unknown as Task);
    this._insertSorted(task as unknown as Task);
    this._emit({ type: "enqueued", task: task as unknown as Task });
    this._tick();
    return task;
  }

  private _insertSorted(task: Task): void {
    // Lower priority number = higher priority, inserted before tasks of equal or lower priority
    let i = 0;
    while (i < this._queue.length && this._queue[i].priority <= task.priority) {
      i++;
    }
    this._queue.splice(i, 0, task);
  }

  // -- Cancel --

  cancel(id: string): boolean {
    const task = this._tasks.get(id);
    if (!task || task.state !== "pending") return false;

    const idx = this._queue.findIndex((t) => t.id === id);
    if (idx !== -1) this._queue.splice(idx, 1);

    task.state = "cancelled";
    task.finishedAt = Date.now();
    this._emit({ type: "cancelled", task });
    return true;
  }

  // -- Inspect --

  get(id: string): Task | undefined {
    return this._tasks.get(id);
  }

  get size(): number {
    return this._queue.length;
  }

  get running(): number {
    return this._running;
  }

  get stats(): { pending: number; running: number; done: number; failed: number; cancelled: number } {
    const counts = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const task of this._tasks.values()) {
      counts[task.state]++;
    }
    return counts;
  }

  // -- Drain: resolves when queue is empty and all running tasks finish --

  drain(): Promise<void> {
    if (this._queue.length === 0 && this._running === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const off = this.on((event) => {
        if (event.type === "drained") {
          off();
          resolve();
        }
      });
    });
  }

  // -- Stop: no new tasks accepted, drain existing --

  stop(): Promise<void> {
    this._stopped = true;
    return this.drain();
  }

  // -- Internal tick --

  private _tick(): void {
    while (this._running < this._concurrency && this._queue.length > 0) {
      const task = this._queue.shift()!;
      this._run(task);
    }
  }

  private _run(task: Task): void {
    task.state = "running";
    task.startedAt = Date.now();
    this._running++;
    this._emit({ type: "started", task });

    const execute = (): Promise<unknown> => {
      if (task.timeoutMs !== undefined) {
        return Promise.race([
          task.fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Task ${task.id} timed out after ${task.timeoutMs}ms`)), task.timeoutMs)
          ),
        ]);
      }
      return task.fn();
    };

    execute()
      .then((result) => {
        task.result = result;
        task.state = "done";
        task.finishedAt = Date.now();
        this._running--;
        this._emit({ type: "done", task });
        this._checkDrained();
        this._tick();
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));

        if (task.retries < task.maxRetries) {
          task.retries++;
          const delayMs = task.retryBaseMs * Math.pow(2, task.retries - 1);
          task.state = "pending";
          this._running--;
          this._emit({ type: "retry", task, attempt: task.retries, delayMs });

          sleep(delayMs).then(() => {
            if (task.state === "cancelled") return;
            this._insertSorted(task);
            this._tick();
          });
        } else {
          task.error = error;
          task.state = "failed";
          task.finishedAt = Date.now();
          this._running--;
          this._emit({ type: "failed", task });
          this._checkDrained();
          this._tick();
        }
      });
  }

  private _checkDrained(): void {
    if (this._queue.length === 0 && this._running === 0) {
      this._emit({ type: "drained" });
    }
  }
}
