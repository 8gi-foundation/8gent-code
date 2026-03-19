/**
 * GitHub Sync — Automated synchronization workflows
 *
 * Sync forks, watch for changes, auto-fetch, repo health checks.
 * These are higher-level workflows that compose basic git/gh operations.
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";
import { execSync } from "child_process";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

function git(cmd: string, cwd: string): string {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", timeout: 30000 }).trim();
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

// ── Sync Fork ──────────────────────────────────────────────

registerTool({
  name: "gh_sync_fork",
  description: "Sync a forked repository with its upstream. Fetches upstream changes and updates the default branch.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Branch to sync (default: default branch)" },
    },
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { branch } = input as { branch?: string };
  const client = gh(ctx);
  let cmd = "repo sync";
  if (branch) cmd += ` --branch ${branch}`;
  const result = client.exec(cmd);
  return { success: true, result };
});

// ── Repo Health Check ──────────────────────────────────────

registerTool({
  name: "gh_repo_health",
  description: "Comprehensive repository health check: open issues/PRs, CI status, stale branches, contributor activity, branch protection.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {},
  },
  permissions: ["github:read"],
}, async (_input: unknown, ctx: ExecutionContext) => {
  const client = gh(ctx);
  const repo = client.getRepo();
  if (!repo) return { error: "Not in a GitHub repository" };

  const health: Record<string, unknown> = { repo: repo.full };

  // Open issues count
  try {
    const issues = client.json<any[]>("issue list --state open --limit 1 --json number");
    const issueCount = client.exec("issue list --state open --json number --jq '. | length'");
    health.openIssues = parseInt(issueCount) || 0;
  } catch {
    health.openIssues = "unknown";
  }

  // Open PRs count
  try {
    const prCount = client.exec("pr list --state open --json number --jq '. | length'");
    health.openPRs = parseInt(prCount) || 0;
  } catch {
    health.openPRs = "unknown";
  }

  // Latest CI status
  try {
    const latestRun = client.exec("run list --limit 1 --json status,conclusion,workflowName");
    health.latestCI = JSON.parse(latestRun || "[]")[0] || null;
  } catch {
    health.latestCI = null;
  }

  // Default branch protection
  try {
    const defaultBranch = git("symbolic-ref refs/remotes/origin/HEAD --short", ctx.workingDirectory).replace("origin/", "");
    health.defaultBranch = defaultBranch;
    try {
      client.api(`repos/${repo.full}/branches/${defaultBranch}/protection`);
      health.branchProtection = true;
    } catch {
      health.branchProtection = false;
    }
  } catch {
    health.defaultBranch = "unknown";
    health.branchProtection = "unknown";
  }

  // Stale branches (>30 days)
  try {
    const output = git(
      "for-each-ref --sort=committerdate --format='%(committerdate:iso8601)' refs/remotes/origin/",
      ctx.workingDirectory
    );
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const staleBranches = output.split("\n").filter(Boolean).filter(d => new Date(d) < cutoff).length;
    health.staleBranches = staleBranches;
  } catch {
    health.staleBranches = "unknown";
  }

  // Recent activity
  try {
    const recentCommits = git("log --oneline -5 --format='%ar'", ctx.workingDirectory);
    health.recentCommits = recentCommits.split("\n").filter(Boolean);
  } catch {
    health.recentCommits = [];
  }

  return health;
});

// ── Fetch All ──────────────────────────────────────────────

registerTool({
  name: "gh_sync_fetch",
  description: "Fetch all remotes, prune deleted branches, and show what changed.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      prune: { type: "boolean", description: "Prune remote-tracking branches that no longer exist (default: true)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { prune = true } = input as { prune?: boolean };
  const cmd = prune ? "fetch --all --prune" : "fetch --all";
  const result = git(cmd, ctx.workingDirectory);
  const branch = git("rev-parse --abbrev-ref HEAD", ctx.workingDirectory);

  let status = "";
  try {
    const ahead = git("rev-list --count @{u}..HEAD", ctx.workingDirectory);
    const behind = git("rev-list --count HEAD..@{u}", ctx.workingDirectory);
    status = `Branch '${branch}': ${ahead} ahead, ${behind} behind`;
  } catch {
    status = `Branch '${branch}': no upstream tracking`;
  }

  return { result: result || "All up to date", branch, status };
});

// ── PR Triage ──────────────────────────────────────────────

registerTool({
  name: "gh_triage",
  description: "Triage dashboard: open PRs needing review, issues without labels, stale items, and CI failures. A quick overview for maintainers.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {},
  },
  permissions: ["github:read"],
}, async (_input: unknown, ctx: ExecutionContext) => {
  const client = gh(ctx);
  const triage: Record<string, unknown> = {};

  // PRs needing review
  try {
    const prsNeedingReview = client.json<any[]>("pr list --state open --json number,title,author,reviewDecision,createdAt,url");
    triage.prsNeedingReview = prsNeedingReview.filter(
      (pr: any) => pr.reviewDecision !== "APPROVED" && pr.reviewDecision !== "CHANGES_REQUESTED"
    );
  } catch {
    triage.prsNeedingReview = [];
  }

  // Issues without labels
  try {
    const unlabeled = client.json<any[]>("issue list --state open --json number,title,labels,createdAt");
    triage.unlabeledIssues = unlabeled.filter((i: any) => !i.labels || i.labels.length === 0);
  } catch {
    triage.unlabeledIssues = [];
  }

  // Failed CI runs
  try {
    const failedRuns = client.json<any[]>("run list --status failure --limit 5 --json databaseId,workflowName,headBranch,createdAt,url");
    triage.failedCI = failedRuns;
  } catch {
    triage.failedCI = [];
  }

  return triage;
});
