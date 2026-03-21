/**
 * WorktreePool — parallel agent execution with git worktree isolation.
 *
 * Inspired by: Claude Code's worktree pattern — isolated parallel agent execution.
 * Pattern abstracted and rebuilt from scratch in <350 lines.
 *
 * Usage:
 *   const pool = new WorktreePool();
 *   const task = await pool.spawn("implement feature X", { model: "llama3" });
 *   const result = await pool.collect(task.id);
 *   await pool.cleanup(task.id);
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import type {
  WorktreeTask,
  WorktreeResult,
  WorktreePoolOptions,
} from "./worktree-pool-types";
import { WorktreePoolAgent } from "./worktree-pool-agent";

const DEFAULT_TIMEOUT = 600_000; // 10 min
const DEFAULT_MAX = 4;

export class WorktreePool {
  private projectRoot: string;
  private worktreesDir: string;
  private maxConcurrent: number;
  private taskTimeoutMs: number;

  private tasks: Map<string, WorktreeTask> = new Map();
  private agents: Map<string, WorktreePoolAgent> = new Map();
  private results: Map<string, WorktreeResult> = new Map();
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(opts: WorktreePoolOptions = {}) {
    this.projectRoot = resolve(opts.projectRoot ?? process.cwd());
    this.worktreesDir = join(this.projectRoot, ".8gent", "worktrees");
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? DEFAULT_TIMEOUT;
    mkdirSync(this.worktreesDir, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Spawn a new worktree agent for the given task.
   * Returns a WorktreeTask immediately — agent starts async.
   */
  async spawn(
    prompt: string,
    opts: { branch?: string; model?: string } = {},
  ): Promise<WorktreeTask> {
    const id = `wt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const branch = opts.branch ?? `8gent/worktree-${id}`;
    const worktreePath = join(this.worktreesDir, id);

    const task: WorktreeTask = {
      id,
      prompt,
      branch,
      worktreePath,
      model: opts.model,
      status: "pending",
      createdAt: Date.now(),
    };

    this.tasks.set(id, task);
    await this.startTask(task);
    return task;
  }

  /**
   * Wait for a task to complete and return its result.
   * Polls result map; resolves immediately if already done.
   */
  collect(taskId: string, pollIntervalMs = 500): Promise<WorktreeResult> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const result = this.results.get(taskId);
        if (result) return resolve(result);

        const task = this.tasks.get(taskId);
        if (!task) return reject(new Error(`Task not found: ${taskId}`));
        if (task.status === "failed" || task.status === "timeout") {
          const r: WorktreeResult = {
            taskId,
            status: task.status,
            filesChanged: [],
            completedAt: Date.now(),
          };
          return resolve(r);
        }

        setTimeout(check, pollIntervalMs);
      };
      check();
    });
  }

  /**
   * Wait for all running tasks to complete, return all results.
   */
  async collectAll(): Promise<WorktreeResult[]> {
    const ids = Array.from(this.tasks.keys());
    return Promise.all(ids.map(id => this.collect(id)));
  }

  /**
   * List all tasks (pending, running, completed, failed).
   */
  list(): WorktreeTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Remove a worktree and its branch. Kills the agent if still running.
   */
  async cleanup(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    this.agents.get(taskId)?.kill();
    this.agents.delete(taskId);

    this.gitWorktreeRemove(task.worktreePath);
    this.gitBranchDelete(task.branch);

    this.tasks.delete(taskId);
    this.results.delete(taskId);
  }

  /**
   * Remove all worktrees and branches. Kills all running agents.
   */
  async cleanupAll(): Promise<void> {
    const ids = Array.from(this.tasks.keys());
    await Promise.all(ids.map(id => this.cleanup(id)));
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async startTask(task: WorktreeTask): Promise<void> {
    if (this.running >= this.maxConcurrent) {
      // Queue until a slot opens
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.running++;
    task.status = "running";
    task.startedAt = Date.now();
    task.pid = undefined;

    try {
      this.gitWorktreeAdd(task.worktreePath, task.branch);
    } catch (err) {
      task.status = "failed";
      this.running--;
      this.drainQueue();
      return;
    }

    const agent = new WorktreePoolAgent(task, this.projectRoot, this.taskTimeoutMs);
    this.agents.set(task.id, agent);

    agent.start((result) => {
      task.status = result.status;
      task.completedAt = result.completedAt;
      this.results.set(task.id, result);
      this.agents.delete(task.id);
      this.running--;
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const next = this.queue.shift();
      next?.();
    }
  }

  private gitWorktreeAdd(path: string, branch: string): void {
    try {
      execFileSync("git", ["worktree", "add", path, "-b", branch], {
        cwd: this.projectRoot,
        stdio: "pipe",
      });
    } catch (err: any) {
      const msg = err.stderr?.toString() ?? "";
      if (msg.includes("already exists")) {
        // Worktree already there — reuse it
        execFileSync("git", ["worktree", "add", path, branch], {
          cwd: this.projectRoot,
          stdio: "pipe",
        });
      } else {
        throw new Error(`git worktree add failed: ${msg || err.message}`);
      }
    }
  }

  private gitWorktreeRemove(path: string): void {
    if (!existsSync(path)) return;
    try {
      execFileSync("git", ["worktree", "remove", path, "--force"], {
        cwd: this.projectRoot,
        stdio: "pipe",
      });
    } catch { /* best effort */ }
  }

  private gitBranchDelete(branch: string): void {
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: this.projectRoot,
        stdio: "pipe",
      });
    } catch { /* best effort */ }
  }
}
