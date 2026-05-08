/**
 * 8gent Code - Worker Pool
 *
 * Manages a pool of Bun worker threads for CPU-bound tasks.
 * No external dependencies - uses Bun's native Worker API.
 * Default pool size matches the CPU count for optimal throughput.
 */

import { cpus } from "os";

export interface WorkerPoolOptions {
  /** Number of worker threads. Defaults to CPU count. */
  size?: number;
  /** Max tasks to queue before rejecting. Default: 1000. */
  maxQueue?: number;
}

interface Task<T, R> {
  fn: string;
  data: T;
  resolve: (result: R) => void;
  reject: (err: Error) => void;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
}

/**
 * WorkerPool - pool of Bun worker threads for CPU-bound operations.
 *
 * Usage:
 *   const pool = new WorkerPool();
 *   const result = await pool.run(myHeavyFn, inputData);
 *   pool.terminate();
 *
 * Note: `fn` must be a serializable function string or a named export
 * of a worker module. For arbitrary functions, pass them as string source.
 */
export class WorkerPool {
  private workers: WorkerState[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: Task<any, any>[] = [];
  private readonly size: number;
  private readonly maxQueue: number;
  private terminated = false;

  constructor(options: WorkerPoolOptions = {}) {
    this.size = options.size ?? cpus().length;
    this.maxQueue = options.maxQueue ?? 1000;
    this._spawnWorkers();
  }

  private _spawnWorkers(): void {
    for (let i = 0; i < this.size; i++) {
      // Inline worker script - evaluates serialized fn with data
      const workerScript = `
        self.onmessage = async (event) => {
          const { taskId, fnSource, data } = event.data;
          try {
            // eslint-disable-next-line no-new-func
            const fn = new Function("data", \`return (\${fnSource})(data)\`);
            const result = await fn(data);
            self.postMessage({ taskId, result });
          } catch (err) {
            self.postMessage({ taskId, error: err.message ?? String(err) });
          }
        };
      `;
      const blob = new Blob([workerScript], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url, { type: "module" });

      const state: WorkerState = { worker, busy: false };

      worker.onmessage = (event: MessageEvent) => {
        const { taskId, result, error } = event.data as {
          taskId: number;
          result?: unknown;
          error?: string;
        };
        const task = this._pendingByTaskId.get(taskId);
        if (!task) return;
        this._pendingByTaskId.delete(taskId);
        state.busy = false;
        if (error) {
          task.reject(new Error(error));
        } else {
          task.resolve(result);
        }
        this._drain();
      };

      worker.onerror = (err: ErrorEvent) => {
        state.busy = false;
        this._drain();
        // Surface error to any waiting callers
        for (const [id, task] of this._pendingByTaskId) {
          task.reject(new Error(err.message));
          this._pendingByTaskId.delete(id);
        }
      };

      this.workers.push(state);
    }
  }

  private _pendingByTaskId: Map<number, Task<unknown, unknown>> = new Map();
  private _nextTaskId = 0;

  /**
   * Run a function on the next available worker.
   * `fn` is serialized via .toString() - must be self-contained (no closures).
   */
  run<T, R>(fn: (data: T) => R | Promise<R>, data: T): Promise<R> {
    if (this.terminated) {
      return Promise.reject(new Error("WorkerPool has been terminated"));
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new Error(`WorkerPool queue full (max ${this.maxQueue})`));
    }

    return new Promise<R>((resolve, reject) => {
      this.queue.push({ fn: fn.toString(), data, resolve, reject });
      this._drain();
    });
  }

  private _drain(): void {
    if (this.queue.length === 0) return;
    const idle = this.workers.find((w) => !w.busy);
    if (!idle) return;

    const task = this.queue.shift()!;
    const taskId = this._nextTaskId++;
    idle.busy = true;
    this._pendingByTaskId.set(taskId, task);
    idle.worker.postMessage({ taskId, fnSource: task.fn, data: task.data });
  }

  /** Terminate all workers immediately. Rejects any pending tasks. */
  terminate(): void {
    this.terminated = true;
    for (const [id, task] of this._pendingByTaskId) {
      task.reject(new Error("WorkerPool terminated"));
      this._pendingByTaskId.delete(id);
    }
    for (const { worker } of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.queue = [];
  }

  /** Current number of queued (waiting) tasks. */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Number of workers currently executing tasks. */
  get activeWorkers(): number {
    return this.workers.filter((w) => w.busy).length;
  }
}
