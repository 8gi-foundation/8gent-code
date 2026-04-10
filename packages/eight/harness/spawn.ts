/**
 * Sub-Agent Spawn Protocol
 *
 * Formal parent-child agent dispatch with git worktree isolation.
 * Pattern: parent creates scoped task -> spawns child in worktree -> child
 * executes and writes structured result to disk -> parent collects.
 *
 * Parallel execution: `Promise.all(tasks.map(t => spawn(t, scope)))`
 *
 * Issue: #1406
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Task definition passed from parent to child. */
export interface SpawnTask {
  /** Human-readable task description */
  description: string;
  /** Structured input the child receives (serializable) */
  input: Record<string, unknown>;
  /** Max execution time in ms (default: 300_000) */
  timeoutMs?: number;
  /** Optional parent-assigned ID (auto-generated if omitted) */
  id?: string;
}

/** Isolation scope for the child agent. */
export interface SpawnScope {
  /** Absolute path to the git repo root */
  projectRoot: string;
  /** Persona or role tag for the branch name (e.g. "engineer", "qa") */
  persona?: string;
  /** Files/dirs the child is allowed to touch (empty = unrestricted) */
  allowedPaths?: string[];
  /** Environment variables injected into the child process */
  env?: Record<string, string>;
}

export type SpawnStatus = "pending" | "running" | "completed" | "failed" | "timeout";

/** Structured result returned by the child. */
export interface SpawnResult {
  /** Task ID (matches SpawnTask.id) */
  taskId: string;
  status: SpawnStatus;
  /** Child's output payload (arbitrary JSON) */
  output?: Record<string, unknown>;
  /** Error message if failed/timeout */
  error?: string;
  /** Files the child modified (relative to worktree root) */
  filesChanged: string[];
  /** Git branch created for this child */
  branch: string;
  /** Absolute path to the worktree (removed after collection unless retained) */
  worktreePath: string;
  /** Wall-clock duration in ms */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal: worktree lifecycle
// ---------------------------------------------------------------------------

const WORKTREES_DIR = ".8gent/spawn-worktrees";
const RESULTS_FILE = ".8gent-spawn-result.json";

interface WorktreeHandle {
  path: string;
  branch: string;
}

async function createWorktree(scope: SpawnScope, taskId: string): Promise<WorktreeHandle> {
  const hash = crypto.randomBytes(4).toString("hex");
  const persona = scope.persona || "child";
  const branch = `spawn/${persona}-${hash}`;
  const dir = path.join(scope.projectRoot, WORKTREES_DIR);
  const wtPath = path.join(dir, `${persona}-${hash}`);

  fs.mkdirSync(dir, { recursive: true });

  await execAsync(`git worktree add "${wtPath}" -b "${branch}"`, {
    cwd: scope.projectRoot,
    timeout: 15_000,
  });

  return { path: wtPath, branch };
}

async function removeWorktree(scope: SpawnScope, handle: WorktreeHandle): Promise<void> {
  try {
    await execAsync(`git worktree remove "${handle.path}" --force`, {
      cwd: scope.projectRoot,
      timeout: 10_000,
    });
  } catch { /* best-effort */ }

  try {
    await execAsync(`git branch -D "${handle.branch}"`, {
      cwd: scope.projectRoot,
      timeout: 5_000,
    });
  } catch { /* branch may already be gone */ }
}

async function getChangedFiles(wtPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git diff --name-only HEAD", {
      cwd: wtPath,
      timeout: 5_000,
    });
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core: spawn
// ---------------------------------------------------------------------------

/**
 * Spawn a child agent in an isolated git worktree.
 *
 * The child receives a task file at `<worktree>/.8gent-spawn-task.json` and
 * is expected to write its result to `<worktree>/.8gent-spawn-result.json`.
 *
 * The execution command defaults to running spawn-child.ts but can be
 * overridden via the SPAWN_CMD environment variable in scope.env.
 *
 * @example
 * ```ts
 * const result = await spawn(
 *   { description: "Add input validation", input: { file: "src/signup.ts" } },
 *   { projectRoot: "/repo", persona: "engineer" },
 * );
 * ```
 *
 * @example Parallel execution
 * ```ts
 * const results = await Promise.all([
 *   spawn(taskA, scope),
 *   spawn(taskB, scope),
 *   spawn(taskC, scope),
 * ]);
 * ```
 */
export async function spawn(task: SpawnTask, scope: SpawnScope): Promise<SpawnResult> {
  const taskId = task.id || `spawn-${crypto.randomBytes(4).toString("hex")}`;
  const timeout = task.timeoutMs ?? 300_000;
  const start = Date.now();
  let handle: WorktreeHandle | undefined;

  try {
    // 1. Create isolated worktree
    handle = await createWorktree(scope, taskId);

    // 2. Write task definition for the child
    const taskFile = path.join(handle.path, ".8gent-spawn-task.json");
    fs.writeFileSync(taskFile, JSON.stringify({ taskId, ...task }, null, 2));

    // 3. Execute child process in the worktree
    const childEnv = { ...process.env, ...scope.env, SPAWN_TASK_ID: taskId };
    const defaultCmd = `bun run ${path.join(scope.projectRoot, "packages/eight/harness/spawn-child.ts")}`;
    const cmd = `${scope.env?.SPAWN_CMD || defaultCmd} "${taskFile}"`;

    await execAsync(cmd, {
      cwd: handle.path,
      timeout,
      env: childEnv,
    });

    // 4. Read structured result
    const resultPath = path.join(handle.path, RESULTS_FILE);
    const filesChanged = await getChangedFiles(handle.path);

    let output: Record<string, unknown> | undefined;
    if (fs.existsSync(resultPath)) {
      output = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    }

    return {
      taskId,
      status: "completed",
      output,
      filesChanged,
      branch: handle.branch,
      worktreePath: handle.path,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.message.includes("TIMEOUT") || err.message.includes("timed out"));

    return {
      taskId,
      status: isTimeout ? "timeout" : "failed",
      error: err instanceof Error ? err.message : String(err),
      filesChanged: handle ? await getChangedFiles(handle.path) : [],
      branch: handle?.branch || "",
      worktreePath: handle?.path || "",
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Spawn multiple children in parallel with a concurrency limit.
 * Settles all tasks (does not short-circuit on individual failure).
 */
export async function spawnAll(
  tasks: SpawnTask[],
  scope: SpawnScope,
  concurrency = 4,
): Promise<SpawnResult[]> {
  const results: SpawnResult[] = [];
  const queue = [...tasks];

  async function worker() {
    while (queue.length > 0) {
      const task = queue.shift()!;
      results.push(await spawn(task, scope));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Clean up a spawn result's worktree. Call after collecting/merging changes.
 */
export async function collect(result: SpawnResult, scope: SpawnScope): Promise<void> {
  if (result.worktreePath && result.branch) {
    await removeWorktree(scope, { path: result.worktreePath, branch: result.branch });
  }
}
