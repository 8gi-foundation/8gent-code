/**
 * DAG Task Scheduler
 * Directed acyclic graph scheduler for parallel task execution.
 * Performs topological sort, tracks dependencies, and runs independent tasks concurrently.
 */

export interface Task<T = unknown> {
  id: string;
  deps: string[];
  run: () => Promise<T>;
}

export interface TaskResult<T = unknown> {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  result?: T;
  error?: Error;
  startedAt?: number;
  finishedAt?: number;
}

export class DAGScheduler<T = unknown> {
  private tasks = new Map<string, Task<T>>();
  private results = new Map<string, TaskResult<T>>();

  add(task: Task<T>): this {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" already registered`);
    }
    this.tasks.set(task.id, task);
    this.results.set(task.id, { id: task.id, status: "pending" });
    return this;
  }

  /** Topological sort via depth-first search. Throws on cycle. */
  private topoSort(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Cycle detected involving task "${id}"`);
      }
      const task = this.tasks.get(id);
      if (!task) throw new Error(`Unknown task "${id}"`);

      visiting.add(id);
      for (const dep of task.deps) {
        visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };

    for (const id of this.tasks.keys()) {
      visit(id);
    }

    return order;
  }

  /** Returns true if all deps for a task are done successfully. */
  private depsComplete(task: Task<T>): boolean {
    return task.deps.every((dep) => this.results.get(dep)?.status === "done");
  }

  /** Returns true if any dep failed (downstream task should be skipped). */
  private depsHaveFailed(task: Task<T>): boolean {
    return task.deps.some((dep) => this.results.get(dep)?.status === "failed");
  }

  async run(): Promise<Map<string, TaskResult<T>>> {
    // Validate graph is acyclic before starting
    this.topoSort();

    const pending = new Set(this.tasks.keys());
    const inFlight = new Map<string, Promise<void>>();

    const dispatch = (id: string) => {
      const task = this.tasks.get(id)!;
      const record = this.results.get(id)!;
      record.status = "running";
      record.startedAt = Date.now();

      const promise = task
        .run()
        .then((result) => {
          record.status = "done";
          record.result = result;
          record.finishedAt = Date.now();
        })
        .catch((err: unknown) => {
          record.status = "failed";
          record.error = err instanceof Error ? err : new Error(String(err));
          record.finishedAt = Date.now();
        })
        .finally(() => {
          inFlight.delete(id);
        });

      inFlight.set(id, promise);
      pending.delete(id);
    };

    while (pending.size > 0 || inFlight.size > 0) {
      for (const id of pending) {
        const task = this.tasks.get(id)!;
        if (this.depsHaveFailed(task)) {
          this.results.get(id)!.status = "failed";
          this.results.get(id)!.error = new Error("Skipped: dependency failed");
          pending.delete(id);
        } else if (this.depsComplete(task)) {
          dispatch(id);
        }
      }

      if (inFlight.size > 0) {
        await Promise.race(inFlight.values());
      } else if (pending.size > 0) {
        throw new Error("Scheduler stalled - check dependency graph");
      }
    }

    return this.results;
  }

  getResult(id: string): TaskResult<T> | undefined {
    return this.results.get(id);
  }

  summary(): { done: number; failed: number; total: number } {
    let done = 0;
    let failed = 0;
    for (const r of this.results.values()) {
      if (r.status === "done") done++;
      if (r.status === "failed") failed++;
    }
    return { done, failed, total: this.tasks.size };
  }
}
