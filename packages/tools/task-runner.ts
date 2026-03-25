import { EventEmitter } from "events";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TaskDef<T = unknown> {
  name: string;
  run: () => Promise<T>;
  retries?: number;
  dependsOn?: string[];
}

export interface TaskResult<T = unknown> {
  name: string;
  status: TaskStatus;
  result?: T;
  error?: Error;
  attempts: number;
  durationMs: number;
}

export interface TaskRunnerOptions {
  concurrency?: number;
  stopOnFailure?: boolean;
}

export class TaskRunner extends EventEmitter {
  private tasks: Map<string, TaskDef> = new Map();
  private results: Map<string, TaskResult> = new Map();
  private opts: Required<TaskRunnerOptions>;

  constructor(opts: TaskRunnerOptions = {}) {
    super();
    this.opts = {
      concurrency: opts.concurrency ?? 1,
      stopOnFailure: opts.stopOnFailure ?? false,
    };
  }

  register<T>(task: TaskDef<T>): this {
    this.tasks.set(task.name, task as TaskDef);
    this.results.set(task.name, {
      name: task.name,
      status: "pending",
      attempts: 0,
      durationMs: 0,
    });
    return this;
  }

  private async runOne(name: string): Promise<TaskResult> {
    const task = this.tasks.get(name)!;
    const result = this.results.get(name)!;
    const maxAttempts = (task.retries ?? 0) + 1;

    result.status = "running";
    this.emit("task:start", { name });

    const start = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      result.attempts = attempt;
      try {
        result.result = await task.run();
        result.status = "done";
        result.durationMs = Date.now() - start;
        this.emit("task:done", { name, result: result.result, attempt, durationMs: result.durationMs });
        return result;
      } catch (err) {
        result.error = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts) {
          this.emit("task:retry", { name, attempt, error: result.error });
        }
      }
    }

    result.status = "failed";
    result.durationMs = Date.now() - start;
    this.emit("task:fail", { name, error: result.error, attempts: result.attempts, durationMs: result.durationMs });
    return result;
  }

  private depsReady(name: string): boolean {
    const deps = this.tasks.get(name)?.dependsOn ?? [];
    return deps.every((d) => this.results.get(d)?.status === "done");
  }

  private depsFailed(name: string): boolean {
    const deps = this.tasks.get(name)?.dependsOn ?? [];
    return deps.some((d) => {
      const s = this.results.get(d)?.status;
      return s === "failed" || s === "skipped";
    });
  }

  async run(): Promise<Map<string, TaskResult>> {
    const names = Array.from(this.tasks.keys());
    const pending = new Set(names);
    const running = new Set<string>();
    let aborted = false;

    this.emit("run:start", { total: names.length });

    const tick = async (): Promise<void> => {
      if (aborted || pending.size === 0) return;

      const ready = Array.from(pending).filter(
        (n) => !running.has(n) && this.depsReady(n)
      );
      const skip = Array.from(pending).filter((n) => this.depsFailed(n));

      for (const name of skip) {
        pending.delete(name);
        const r = this.results.get(name)!;
        r.status = "skipped";
        this.emit("task:skip", { name });
      }

      const slots = this.opts.concurrency - running.size;
      const batch = ready.slice(0, slots);

      if (batch.length === 0 && running.size === 0 && pending.size > 0) {
        // Dependency cycle or unresolvable - skip remaining
        for (const name of Array.from(pending)) {
          const r = this.results.get(name)!;
          r.status = "skipped";
          this.emit("task:skip", { name, reason: "unresolvable" });
          pending.delete(name);
        }
        return;
      }

      const promises = batch.map(async (name) => {
        pending.delete(name);
        running.add(name);
        const result = await this.runOne(name);
        running.delete(name);
        if (result.status === "failed" && this.opts.stopOnFailure) {
          aborted = true;
        }
        await tick();
      });

      await Promise.all(promises);
    };

    await tick();

    this.emit("run:done", { results: this.results });
    return this.results;
  }

  getStatus(): Map<string, TaskStatus> {
    const out = new Map<string, TaskStatus>();
    for (const [name, r] of this.results) out.set(name, r.status);
    return out;
  }
}
