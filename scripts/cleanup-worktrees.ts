#!/usr/bin/env bun
/**
 * Worktree Cleanup Utility
 *
 * Lists all git worktrees, identifies stale agent worktrees
 * (no active process using them), and removes them safely.
 *
 * Usage:
 *   bun run scripts/cleanup-worktrees.ts           # dry run (default)
 *   bun run scripts/cleanup-worktrees.ts --force    # actually remove
 */

import { $ } from "bun";

const DRY_RUN = !process.argv.includes("--force");

interface WorktreeInfo {
  path: string;
  branch: string;
  isAgent: boolean;
  hasProcess: boolean;
}

async function listWorktrees(): Promise<WorktreeInfo[]> {
  const raw = await $`git worktree list --porcelain`.text();
  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "") {
      if (current.path) {
        entries.push({
          path: current.path,
          branch: current.branch ?? "(detached)",
          isAgent: current.path.includes("/worktrees/agent-"),
          hasProcess: false,
        });
      }
      current = {};
    }
  }
  return entries;
}

async function hasActiveProcess(worktreePath: string): Promise<boolean> {
  try {
    // Check if any process has files open in this worktree path
    const result = await $`lsof +D ${worktreePath} 2>/dev/null`.quiet().text();
    return result.trim().length > 0;
  } catch {
    // lsof returns non-zero when no matches - that means no active process
    return false;
  }
}

async function removeWorktree(path: string): Promise<void> {
  await $`git worktree remove --force ${path}`.quiet();
}

async function main() {
  console.log(DRY_RUN ? "[DRY RUN] Pass --force to actually remove.\n" : "[FORCE MODE] Removing stale worktrees.\n");

  const worktrees = await listWorktrees();
  const agents = worktrees.filter((w) => w.isAgent);
  const mainTree = worktrees.find((w) => !w.isAgent);

  console.log(`Total worktrees: ${worktrees.length}`);
  console.log(`Agent worktrees: ${agents.length}`);
  console.log(`Main worktree:   ${mainTree?.path ?? "unknown"}\n`);

  // Check each agent worktree for active processes
  const stale: WorktreeInfo[] = [];
  for (const wt of agents) {
    wt.hasProcess = await hasActiveProcess(wt.path);
    if (!wt.hasProcess) stale.push(wt);
  }

  const active = agents.length - stale.length;
  console.log(`Active (have process): ${active}`);
  console.log(`Stale  (no process):   ${stale.length}\n`);

  if (stale.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  let removed = 0;
  let failed = 0;
  for (const wt of stale) {
    const label = `${wt.branch} (${wt.path.split("/").pop()})`;
    if (DRY_RUN) {
      console.log(`  [would remove] ${label}`);
      removed++;
    } else {
      try {
        await removeWorktree(wt.path);
        console.log(`  [removed] ${label}`);
        removed++;
      } catch (e) {
        console.log(`  [failed]  ${label} - ${e}`);
        failed++;
      }
    }
  }

  // Prune any dangling worktree references
  if (!DRY_RUN) {
    await $`git worktree prune`.quiet();
  }

  console.log(`\nSummary: ${removed} ${DRY_RUN ? "would be removed" : "removed"}, ${failed} failed, ${active} kept (active).`);
}

main().catch((e) => {
  console.error("Cleanup failed:", e);
  process.exit(1);
});
