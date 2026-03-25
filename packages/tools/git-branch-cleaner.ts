/**
 * git-branch-cleaner
 * Identifies and cleans stale or merged git branches.
 * Supports dry-run preview and local or remote deletion.
 */

import { execSync } from "child_process";

export interface BranchInfo {
  name: string;
  lastCommitDate: Date;
  lastCommitHash: string;
  author: string;
  daysSinceCommit: number;
  mergedIntoMain: boolean;
}

export interface CleanResult {
  deleted: string[];
  failed: Array<{ branch: string; error: string }>;
}

function runGit(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

function getAllBranches(remote = false): string[] {
  const flag = remote ? "-r" : "--list";
  const output = runGit(`branch ${flag} --format=%(refname:short)`);
  return output
    .split("\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => !b.includes("HEAD"));
}

function getBranchInfo(branchName: string): BranchInfo {
  const log = runGit(
    `log -1 --format="%H|%ai|%an" ${branchName}`
  );
  const [hash, dateStr, author] = log.split("|");
  const lastCommitDate = new Date(dateStr);
  const daysSinceCommit = Math.floor(
    (Date.now() - lastCommitDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  let mergedIntoMain = false;
  try {
    const merged = runGit(`branch --merged main`);
    mergedIntoMain = merged
      .split("\n")
      .map((b) => b.trim().replace(/^\* /, ""))
      .includes(branchName);
  } catch {
    // ignore - branch or main may not exist
  }

  return {
    name: branchName,
    lastCommitDate,
    lastCommitHash: hash,
    author,
    daysSinceCommit,
    mergedIntoMain,
  };
}

/** Returns branches with no commits in the last N days */
export function listStale(days = 30): BranchInfo[] {
  const branches = getAllBranches();
  const current = runGit("branch --show-current");
  return branches
    .filter((b) => b !== "main" && b !== "master" && b !== current)
    .map(getBranchInfo)
    .filter((b) => b.daysSinceCommit >= days);
}

/** Returns branches that have been merged into main */
export function listMerged(): BranchInfo[] {
  const current = runGit("branch --show-current");
  try {
    const mergedRaw = runGit("branch --merged main --format=%(refname:short)");
    return mergedRaw
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean)
      .filter((b) => b !== "main" && b !== "master" && b !== current)
      .map(getBranchInfo);
  } catch {
    return [];
  }
}

/** Shows a preview of what would be deleted without making changes */
export function dryRun(branches: BranchInfo[]): void {
  if (branches.length === 0) {
    console.log("No branches to delete.");
    return;
  }
  console.log(`\nDry run - would delete ${branches.length} branch(es):\n`);
  for (const b of branches) {
    const mergedTag = b.mergedIntoMain ? " [merged]" : "";
    console.log(
      `  ${b.name}${mergedTag} — last commit ${b.daysSinceCommit}d ago by ${b.author}`
    );
  }
  console.log("\nNo changes made. Pass these branches to clean() to delete.");
}

/**
 * Deletes the provided branches.
 * @param branches - branches to delete (from listStale or listMerged)
 * @param remote - if true, also deletes from origin remote
 */
export async function clean(
  branches: BranchInfo[],
  remote = false
): Promise<CleanResult> {
  const deleted: string[] = [];
  const failed: Array<{ branch: string; error: string }> = [];
  const current = runGit("branch --show-current");

  for (const b of branches) {
    if (b.name === "main" || b.name === "master" || b.name === current) {
      failed.push({ branch: b.name, error: "Refusing to delete protected branch" });
      continue;
    }
    try {
      runGit(`branch -d ${b.name}`);
      if (remote) {
        runGit(`push origin --delete ${b.name}`);
      }
      deleted.push(b.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ branch: b.name, error: msg });
    }
  }

  return { deleted, failed };
}
