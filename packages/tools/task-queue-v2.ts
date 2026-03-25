/**
 * TaskQueue v2 - task queue with dead letter queue, replay, configurable
 * retry/backoff, and concurrency control.
 *
 * Failed tasks (exceeding maxRetries) move to the dead letter queue (DLQ).
 * DLQ items can be replayed individually. Supports pause/resume and exposes
 * live stats.
 */

export interface TaskOptions {
  id?: string;
  maxRetries?: number;
}

export interface TaskItem<T> {
  id: string;
  payload: T;
  attempts: number;
  maxRetries: number;
  enqueuedAt: number;
  lastError?: string;
}

export interface DLQItem<T> extends TaskItem<T> {
  failedAt: number;
  finalError: string;
}

export interface TaskQueueOptions {
  /** Max concurrent tasks in flight. Default: 3 */
  concurrency?: number;
  /** Max retries per task before moving to DLQ. Default: 3 */
  maxRetries?: number;
  /** Base backoff in ms (doubles each retry). Default: 500 */
  backoffMs?: number;
}

export interface TaskQueueStats {
  pending: number;
  inFlight: number;
  processed: number;
  failed: number;
  dlqSize: number;
  paused: boolean;
}

let _idCounter = 0;
function nextId(): string {
  return `task-${Date.now()}-${++_idCounter}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaskQueue<T> {
  private queue: TaskItem<T>[] = [];
  private dlq: DLQItem<T>[] = [];

  private concurrency: number;
  private defaultMaxRetries: number;
  private backoffMs: number;

  private inFlight = 0;
  private processed = 0;
  private failed = 0;
  private _paused = false;

  private handler?: (payload: T) => Promise<void>;
  private running = false;

  constructor(options: TaskQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 3;
    this.defaultMaxRetries = options.maxRetries ?? 3;
    this.backoffMs = options.backoffMs ?? 500;
  }

  /** Enqueue a task. Returns the assigned task id. */
  enqueue(payload: T, options: TaskOptions = {}): string {
    const id = options.id ?? nextId();
    this.queue.push({
      id,
      payload,
      attempts: 0,
      maxRetries: options.maxRetries ?? this.defaultMaxRetries,
      enqueuedAt: Date.now(),
    });
    if (this.running && !this._paused) this._tick();
    return id;
  }

  /** Start processing. Must be called once with the handler function. */
  process(handler: (payload: T) => Promise<void>): void {
    this.handler = handler;
    this.running = true;
    this._tick();
  }

  /** Replay a DLQ item by id. Re-enqueues with fresh retry counter. */
  replay(dlqItemId: string): boolean {
    const idx = this.dlq.findIndex((d) => d.id === dlqItemId);
    if (idx === -1) return false;
    const [item] = this.dlq.splice(idx, 1);
    this.enqueue(item.payload, { id: item.id, maxRetries: item.maxRetries });
    return true;
  }

  /** Pause task processing. In-flight tasks complete normally. */
  pause(): void {
    this._paused = true;
  }

  /** Resume paused processing. */
  resume(): void {
    this._paused = false;
    this._tick();
  }

  get deadLetterQueue(): readonly DLQItem<T>[] {
    return this.dlq;
  }

  stats(): TaskQueueStats {
    return {
      pending: this.queue.length,
      inFlight: this.inFlight,
      processed: this.processed,
      failed: this.failed,
      dlqSize: this.dlq.length,
      paused: this._paused,
    };
  }

  private _tick(): void {
    if (!this.handler || this._paused) return;
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.inFlight++;
      this._run(task);
    }
  }

  private async _run(task: TaskItem<T>): Promise<void> {
    try {
      task.attempts++;
      await this.handler!(task.payload);
      this.processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      task.lastError = msg;
      if (task.attempts < task.maxRetries) {
        const backoff = this.backoffMs * Math.pow(2, task.attempts - 1);
        await delay(backoff);
        this.queue.unshift(task); // re-queue at front for retry
      } else {
        this.failed++;
        this.dlq.push({ ...task, failedAt: Date.now(), finalError: msg });
      }
    } finally {
      this.inFlight--;
      this._tick();
    }
  }
}
