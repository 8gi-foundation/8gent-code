/**
 * Filesystem-based task queue for agent coordination.
 *
 * Tasks are stored as individual JSON files so multiple agents (each in their
 * own worktree / process) can read and claim work without any shared-memory
 * coordination — the filesystem *is* the message bus.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  assignee: string;
  description: string;
  priority: number;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAt: number;
  updatedAt?: number;
  result?: unknown;
  error?: string;
}

export type TaskInput = Pick<Task, "id" | "assignee" | "description"> & {
  priority?: number;
};

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export class TaskQueue {
  constructor(private basePath: string) {
    mkdirSync(basePath, { recursive: true });
  }

  /** Add a task to the queue */
  enqueue(input: TaskInput): Task {
    const task: Task = {
      ...input,
      priority: input.priority ?? 0,
      status: "pending",
      createdAt: Date.now(),
    };
    const filename = `${String(task.priority).padStart(3, "0")}-${Date.now()}-${task.id}.json`;
    writeFileSync(
      join(this.basePath, filename),
      JSON.stringify(task, null, 2),
    );
    return task;
  }

  /** Claim the next pending task (optionally filtered by assignee) */
  dequeue(assignee?: string): Task | null {
    const files = readdirSync(this.basePath)
      .filter((f) => f.endsWith(".json"))
      .sort(); // priority prefix ensures highest-priority first

    for (const f of files) {
      const filePath = join(this.basePath, f);
      const task: Task = JSON.parse(readFileSync(filePath, "utf-8"));
      if (
        task.status === "pending" &&
        (!assignee || task.assignee === assignee)
      ) {
        task.status = "in_progress";
        task.updatedAt = Date.now();
        writeFileSync(filePath, JSON.stringify(task, null, 2));
        return task;
      }
    }
    return null;
  }

  /** Mark a task as completed */
  complete(taskId: string, result?: unknown): void {
    this.updateTask(taskId, (t) => {
      t.status = "completed";
      t.result = result;
      t.updatedAt = Date.now();
    });
  }

  /** Mark a task as failed */
  fail(taskId: string, error: string): void {
    this.updateTask(taskId, (t) => {
      t.status = "failed";
      t.error = error;
      t.updatedAt = Date.now();
    });
  }

  /** List pending tasks (optionally filtered by assignee) */
  listPending(assignee?: string): Task[] {
    return this.listAll().filter(
      (t) =>
        t.status === "pending" &&
        (!assignee || t.assignee === assignee),
    );
  }

  /** List every task regardless of status */
  listAll(): Task[] {
    if (!existsSync(this.basePath)) return [];
    return readdirSync(this.basePath)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        try {
          return JSON.parse(
            readFileSync(join(this.basePath, f), "utf-8"),
          ) as Task;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Task[];
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private updateTask(taskId: string, mutate: (t: Task) => void): void {
    const files = readdirSync(this.basePath).filter((f) =>
      f.endsWith(".json"),
    );
    for (const f of files) {
      const filePath = join(this.basePath, f);
      const task: Task = JSON.parse(readFileSync(filePath, "utf-8"));
      if (task.id === taskId) {
        mutate(task);
        writeFileSync(filePath, JSON.stringify(task, null, 2));
        return;
      }
    }
  }
}
