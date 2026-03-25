/**
 * 8gent - Daily Standup Summary Generator
 *
 * Reads git log (last 24h) and open PRs, then formats a standup update
 * suitable for Telegram or Slack. Designed to run as a morning cron job.
 *
 * Usage:
 *   bun run packages/proactive/standup-generator.ts
 *   bun run packages/proactive/standup-generator.ts --json
 *   bun run packages/proactive/standup-generator.ts --hours 48
 */

import { $ } from "bun";
import { join } from "path";

// ============================================
// Types
// ============================================

export interface StandupReport {
  date: string;
  done: string[];
  inProgress: string[];
  blocked: string[];
  stats: { commits: number; filesChanged: number; prsOpen: number };
}

export interface StandupConfig {
  repoPath?: string;
  hours?: number;
  format?: "text" | "json";
  ghOwnerRepo?: string;
}

// ============================================
// Git log extraction
// ============================================

async function getRecentCommits(repoPath: string, hours: number): Promise<string[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  try {
    const result = await $`git -C ${repoPath} log --since=${since} --pretty=format:%s --no-merges`.text();
    return result.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function getFilesChanged(repoPath: string, hours: number): Promise<number> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  try {
    const result = await $`git -C ${repoPath} log --since=${since} --pretty=format: --name-only --no-merges`.text();
    const files = new Set(result.trim().split("\n").filter(Boolean));
    return files.size;
  } catch {
    return 0;
  }
}

async function getUncommittedWork(repoPath: string): Promise<string[]> {
  try {
    const result = await $`git -C ${repoPath} diff --stat HEAD`.text();
    if (!result.trim()) return [];
    return ["Uncommitted changes in working tree"];
  } catch {
    return [];
  }
}

// ============================================
// GitHub PR extraction
// ============================================

async function getOpenPRs(ownerRepo: string): Promise<{ title: string; draft: boolean; url: string }[]> {
  try {
    const result = await $`gh pr list --repo ${ownerRepo} --state open --json title,isDraft,url --limit 20`.text();
    const prs = JSON.parse(result) as { title: string; isDraft: boolean; url: string }[];
    return prs.map((pr) => ({ title: pr.title, draft: pr.isDraft, url: pr.url }));
  } catch {
    return [];
  }
}

// ============================================
// Report builder
// ============================================

export async function generateStandup(config: StandupConfig = {}): Promise<StandupReport> {
  const repoPath = config.repoPath || process.cwd();
  const hours = config.hours || 24;

  // Detect gh owner/repo from git remote if not provided
  let ownerRepo = config.ghOwnerRepo || "";
  if (!ownerRepo) {
    try {
      const remote = await $`git -C ${repoPath} remote get-url origin`.text();
      const match = remote.trim().match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/);
      if (match) ownerRepo = match[1];
    } catch { /* no remote, skip PRs */ }
  }

  const [commits, filesChanged, uncommitted, prs] = await Promise.all([
    getRecentCommits(repoPath, hours),
    getFilesChanged(repoPath, hours),
    getUncommittedWork(repoPath),
    ownerRepo ? getOpenPRs(ownerRepo) : Promise.resolve([]),
  ]);

  const done = commits.length > 0 ? commits : ["No commits in the last " + hours + "h"];
  const inProgress = [
    ...uncommitted,
    ...prs.filter((pr) => pr.draft).map((pr) => `Draft PR: ${pr.title}`),
  ];
  const blocked: string[] = [];

  // Heuristic: PRs open > 3 days are likely blocked (we flag all non-draft PRs as review-pending)
  for (const pr of prs.filter((p) => !p.draft)) {
    inProgress.push(`PR awaiting review: ${pr.title}`);
  }

  return {
    date: new Date().toISOString().slice(0, 10),
    done,
    inProgress: inProgress.length > 0 ? inProgress : ["Nothing tracked"],
    blocked: blocked.length > 0 ? blocked : ["None"],
    stats: { commits: commits.length, filesChanged, prsOpen: prs.length },
  };
}

// ============================================
// Formatters
// ============================================

export function formatText(report: StandupReport): string {
  const lines: string[] = [
    `Daily Standup - ${report.date}`,
    "",
    "DONE:",
    ...report.done.map((d) => `  - ${d}`),
    "",
    "IN PROGRESS:",
    ...report.inProgress.map((d) => `  - ${d}`),
    "",
    "BLOCKED:",
    ...report.blocked.map((d) => `  - ${d}`),
    "",
    `Stats: ${report.stats.commits} commits | ${report.stats.filesChanged} files changed | ${report.stats.prsOpen} open PRs`,
  ];
  return lines.join("\n");
}

// ============================================
// CLI entry point
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const hoursIdx = args.indexOf("--hours");
  const hours = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1], 10) : 24;

  const report = await generateStandup({ hours });

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatText(report));
  }
}
