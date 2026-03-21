/**
 * WorktreePoolAgent — runs a single agent subprocess inside a worktree.
 *
 * Spawns: bun run packages/eight/index.ts --worktree <path> <prompt>
 * Result written to: <worktree>/.8gent/result.json
 */

import { spawn, execFileSync, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { WorktreeTask, WorktreeResult, WorktreeTaskStatus } from "./worktree-pool-types";

export class WorktreePoolAgent {
  private proc: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onDone: ((result: WorktreeResult) => void) | null = null;

  constructor(
    private task: WorktreeTask,
    private projectRoot: string,
    private timeoutMs: number,
  ) {}

  start(onDone: (result: WorktreeResult) => void): void {
    this.onDone = onDone;

    const logDir = join(this.task.worktreePath, ".8gent");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "output.log");

    // Env flags so the sub-agent knows its context
    const env = {
      ...process.env,
      EIGHT_WORKTREE_ID: this.task.id,
      EIGHT_WORKTREE_PATH: this.task.worktreePath,
      ...(this.task.model ? { EIGHGENT_MODEL: this.task.model } : {}),
    };

    this.proc = spawn(
      "bun",
      ["run", "packages/eight/index.ts", this.task.prompt],
      {
        cwd: this.task.worktreePath,
        stdio: ["pipe", "pipe", "pipe"],
        env,
        detached: false,
      },
    );

    this.proc.stdout?.on("data", (d: Buffer) => appendFileSync(logPath, d));
    this.proc.stderr?.on("data", (d: Buffer) => appendFileSync(logPath, `[ERR] ${d}`));

    this.timer = setTimeout(() => this.finish("timeout", null, "Task timed out"), this.timeoutMs);

    this.proc.on("close", (code) => {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      const status: WorktreeTaskStatus = code === 0 ? "completed" : "failed";
      this.finish(status, code, code !== 0 ? `Process exited with code ${code}` : undefined);
    });
  }

  kill(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.proc?.kill("SIGTERM");
  }

  private finish(status: WorktreeTaskStatus, exitCode: number | null, error?: string): void {
    const filesChanged = this.getChangedFiles();
    const result: WorktreeResult = {
      taskId: this.task.id,
      status,
      exitCode: exitCode ?? undefined,
      error,
      filesChanged,
      completedAt: Date.now(),
    };

    // Persist result for polling / recovery
    const resultPath = join(this.task.worktreePath, ".8gent", "result.json");
    try {
      writeFileSync(resultPath, JSON.stringify(result, null, 2));
    } catch { /* best effort */ }

    this.onDone?.(result);
  }

  private getChangedFiles(): string[] {
    try {
      const out = execFileSync("git", ["diff", "--name-only", "HEAD"], {
        cwd: this.task.worktreePath,
        encoding: "utf-8",
      });
      return out.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Read result.json if the agent has already completed (for recovery) */
  static readResult(worktreePath: string): WorktreeResult | null {
    const p = join(worktreePath, ".8gent", "result.json");
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
  }
}
