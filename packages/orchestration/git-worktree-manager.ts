/**
 * git-worktree-manager.ts
 *
 * Pool-managed git worktrees for parallel development workflows.
 * Adds pool caps, command execution in worktree context, and stale
 * worktree cleanup on top of the core worktree primitives.
 *
 * Pool model: max 4 concurrent worktrees (same as WorktreePool).
 * Stale threshold: worktrees idle > 30 min are auto-pruned.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import * as crypto from "crypto";

const execAsync = promisify(exec);

const MAX_POOL_SIZE = 4;
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export interface ManagedWorktree {
  id: string;
  path: string;
  branch: string;
  createdAt: Date;
  lastActiveAt: Date;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitWorktreeManager {
  private repoRoot: string;
  private baseDir: string;
  private pool: Map<string, ManagedWorktree> = new Map();

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = resolve(repoRoot);
    this.baseDir = join(this.repoRoot, ".8gent", "parallel-worktrees");
  }

  /** Create a new managed worktree. Rejects if pool is full. */
  async create(label: string): Promise<ManagedWorktree> {
    await this.pruneStale();

    if (this.pool.size >= MAX_POOL_SIZE) {
      throw new Error(
        `Worktree pool full (${MAX_POOL_SIZE} max). Remove a worktree first.`
      );
    }

    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    const id = `${label}-${crypto.randomBytes(3).toString("hex")}`;
    const branch = `wt/${id}`;
    const path = join(this.baseDir, id);

    await execAsync(`git worktree add "${path}" -b "${branch}"`, {
      cwd: this.repoRoot,
      timeout: 15_000,
    });

    const now = new Date();
    const entry: ManagedWorktree = {
      id,
      path,
      branch,
      createdAt: now,
      lastActiveAt: now,
    };

    this.pool.set(id, entry);
    return entry;
  }

  /** Run a shell command inside a worktree. Updates lastActiveAt. */
  async run(id: string, command: string): Promise<CommandResult> {
    const wt = this.pool.get(id);
    if (!wt) throw new Error(`Worktree "${id}" not found in pool.`);

    wt.lastActiveAt = new Date();

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: wt.path,
        timeout: 60_000,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: e.code ?? 1,
      };
    }
  }

  /** Remove a worktree and delete its branch. */
  async remove(id: string): Promise<void> {
    const wt = this.pool.get(id);
    if (!wt) return;

    this.pool.delete(id);

    try {
      await execAsync(`git worktree remove "${wt.path}" --force`, {
        cwd: this.repoRoot,
        timeout: 10_000,
      });
    } catch {
      if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
      await execAsync("git worktree prune", { cwd: this.repoRoot }).catch(() => {});
    }

    await execAsync(`git branch -D "${wt.branch}"`, {
      cwd: this.repoRoot,
      timeout: 5_000,
    }).catch(() => {});
  }

  /** List all active worktrees in the pool. */
  list(): ManagedWorktree[] {
    return Array.from(this.pool.values());
  }

  /** Prune worktrees idle longer than STALE_THRESHOLD_MS. */
  async pruneStale(): Promise<string[]> {
    const now = Date.now();
    const pruned: string[] = [];

    for (const [id, wt] of this.pool) {
      if (now - wt.lastActiveAt.getTime() > STALE_THRESHOLD_MS) {
        await this.remove(id).catch(() => {});
        pruned.push(id);
      }
    }

    return pruned;
  }

  /** Remove all worktrees (shutdown cleanup). */
  async removeAll(): Promise<void> {
    const ids = Array.from(this.pool.keys());
    for (const id of ids) {
      await this.remove(id).catch(() => {});
    }
  }
}
