/**
 * 8gent Code - Git Checkpoint
 *
 * Atomic checkpoint system using git stash.
 * Create a named checkpoint before risky changes, restore if they fail.
 */

import { spawnSync } from "child_process";

export interface Checkpoint {
  id: string;         // Unique ID (timestamp-based)
  stashRef: string;   // "stash@{N}" or "clean" if nothing to stash
  branch: string;     // Branch at checkpoint time
  timestamp: string;
  label: string;
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return {
    ok: r.status === 0,
    out: ((r.stdout ?? "") + (r.stderr ?? "")).trim(),
  };
}

/**
 * Create a checkpoint by stashing current work.
 * Returns the checkpoint descriptor.
 */
export function createCheckpoint(cwd: string, label: string): Checkpoint {
  const id = `heal-${Date.now()}`;

  // Capture current branch
  const branchResult = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = branchResult.ok ? branchResult.out : "unknown";

  // Check if there's anything to stash
  const statusResult = git(["status", "--porcelain"], cwd);
  const isDirty = statusResult.ok && statusResult.out.length > 0;

  let stashRef = "clean";
  if (isDirty) {
    const stashResult = git(["stash", "push", "-u", "-m", id], cwd);
    if (stashResult.ok) {
      // Get the stash index (stash@{0} is always the latest)
      stashRef = "stash@{0}";
    }
  }

  return {
    id,
    stashRef,
    branch,
    timestamp: new Date().toISOString(),
    label,
  };
}

/**
 * Restore to a checkpoint by popping the stash.
 * Discards any changes made after the checkpoint.
 */
export function restoreCheckpoint(cwd: string, checkpoint: Checkpoint): boolean {
  if (checkpoint.stashRef === "clean") {
    // Nothing was stashed — just reset any changes made since
    const reset = git(["checkout", "--", "."], cwd);
    const clean = git(["clean", "-fd"], cwd);
    return reset.ok && clean.ok;
  }

  // Discard changes since checkpoint, then restore stash
  git(["checkout", "--", "."], cwd);
  git(["clean", "-fd"], cwd);

  const pop = git(["stash", "pop"], cwd);
  return pop.ok;
}

/**
 * Drop a checkpoint (cleanup after successful healing).
 */
export function dropCheckpoint(cwd: string, checkpoint: Checkpoint): void {
  if (checkpoint.stashRef !== "clean") {
    git(["stash", "drop"], cwd);
  }
}
