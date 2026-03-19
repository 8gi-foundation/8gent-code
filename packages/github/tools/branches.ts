/**
 * GitHub Branches — Branch management beyond basic git
 *
 * Compare branches, view protection rules, manage branch policies.
 * Combines `git` local operations with `gh api` for GitHub-specific features.
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

// ── Compare Branches ───────────────────────────────────────

registerTool({
  name: "gh_branch_compare",
  description: "Compare two branches: commits ahead/behind, files changed, diff stats. Great for pre-merge analysis.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      base: { type: "string", description: "Base branch (e.g., 'main')" },
      head: { type: "string", description: "Head branch to compare (default: current branch)" },
    },
    required: ["base"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { base, head } = input as { base: string; head?: string };
  const headRef = head || git("rev-parse --abbrev-ref HEAD", ctx.workingDirectory);

  const ahead = git(`rev-list --count ${base}..${headRef}`, ctx.workingDirectory);
  const behind = git(`rev-list --count ${headRef}..${base}`, ctx.workingDirectory);
  const diffStat = git(`diff --stat ${base}...${headRef}`, ctx.workingDirectory);
  const commits = git(`log --oneline ${base}..${headRef}`, ctx.workingDirectory);
  const files = git(`diff --name-only ${base}...${headRef}`, ctx.workingDirectory);

  return {
    base,
    head: headRef,
    ahead: parseInt(ahead),
    behind: parseInt(behind),
    commits: commits.split("\n").filter(Boolean),
    filesChanged: files.split("\n").filter(Boolean),
    diffStat,
  };
});

// ── List Remote Branches ───────────────────────────────────

registerTool({
  name: "gh_branch_list",
  description: "List branches with last commit info. Shows local and remote branches.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      remote: { type: "boolean", description: "Include remote branches (default: true)" },
      pattern: { type: "string", description: "Filter by pattern (e.g., 'feature/*')" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { remote = true, pattern } = input as { remote?: boolean; pattern?: string };
  let cmd = `branch --format='%(refname:short)|%(objectname:short)|%(authorname)|%(committerdate:relative)|%(subject)' -v`;
  if (remote) cmd += " -a";
  const output = git(cmd, ctx.workingDirectory);
  let branches = output.split("\n").filter(Boolean).map(line => {
    const [name, hash, author, date, ...msg] = line.split("|");
    return { name, hash, author, date, message: msg.join("|") };
  });

  if (pattern) {
    const regex = new RegExp(pattern.replace(/\*/g, ".*"));
    branches = branches.filter(b => regex.test(b.name));
  }

  const current = git("rev-parse --abbrev-ref HEAD", ctx.workingDirectory);
  return { current, branches };
});

// ── Delete Remote Branch ───────────────────────────────────

registerTool({
  name: "gh_branch_delete",
  description: "Delete a branch (local, remote, or both). Refuses to delete protected branches.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Branch name to delete" },
      remote: { type: "boolean", description: "Also delete remote branch (default: false)" },
      force: { type: "boolean", description: "Force delete even if not fully merged (default: false)" },
    },
    required: ["branch"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { branch, remote = false, force = false } = input as { branch: string; remote?: boolean; force?: boolean };

  // Safety: refuse protected branches
  const protectedBranches = ["main", "master", "production", "release"];
  if (protectedBranches.includes(branch)) {
    return { success: false, error: `Refusing to delete protected branch '${branch}'` };
  }

  const results: string[] = [];

  // Delete local
  const flag = force ? "-D" : "-d";
  try {
    results.push(git(`branch ${flag} ${branch}`, ctx.workingDirectory));
  } catch (err: any) {
    results.push(`Local: ${err.message}`);
  }

  // Delete remote
  if (remote) {
    try {
      results.push(git(`push origin --delete ${branch}`, ctx.workingDirectory));
    } catch (err: any) {
      results.push(`Remote: ${err.message}`);
    }
  }

  return { success: true, branch, remote, results };
});

// ── View Branch Protection ─────────────────────────────────

registerTool({
  name: "gh_branch_protection",
  description: "View branch protection rules for a branch. Shows required reviews, status checks, and restrictions.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Branch name (default: default branch)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { branch } = input as { branch?: string };
  const client = gh(ctx);
  const repo = client.getRepo();
  if (!repo) return { error: "Not in a GitHub repository" };

  const branchName = branch || git("symbolic-ref refs/remotes/origin/HEAD --short", ctx.workingDirectory).replace("origin/", "");

  try {
    const protection = client.api(`repos/${repo.full}/branches/${branchName}/protection`);
    return { branch: branchName, protection };
  } catch {
    return { branch: branchName, protection: null, message: "No protection rules configured" };
  }
});

// ── Merge Branch ───────────────────────────────────────────

registerTool({
  name: "gh_branch_merge",
  description: "Merge a branch into the current branch. Supports merge, squash, and fast-forward strategies.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      branch: { type: "string", description: "Branch to merge from" },
      strategy: { type: "string", description: "'merge', 'squash', or 'ff-only' (default: merge)" },
      message: { type: "string", description: "Custom merge commit message" },
    },
    required: ["branch"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { branch, strategy = "merge", message } = input as { branch: string; strategy?: string; message?: string };

  let cmd = `merge ${branch}`;
  if (strategy === "squash") cmd += " --squash";
  else if (strategy === "ff-only") cmd += " --ff-only";
  if (message) cmd += ` -m "${message.replace(/"/g, '\\"')}"`;

  const result = git(cmd, ctx.workingDirectory);
  const current = git("rev-parse --abbrev-ref HEAD", ctx.workingDirectory);
  return { success: true, merged: branch, into: current, strategy, result };
});

// ── Stale Branches ─────────────────────────────────────────

registerTool({
  name: "gh_branch_stale",
  description: "Find stale branches that haven't been updated recently. Useful for cleanup.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "number", description: "Consider stale after N days (default: 30)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { days = 30 } = input as { days?: number };
  const output = git(
    `for-each-ref --sort=committerdate --format='%(refname:short)|%(committerdate:iso8601)|%(authorname)|%(subject)' refs/remotes/origin/`,
    ctx.workingDirectory
  );

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const stale = output.split("\n").filter(Boolean).map(line => {
    const [name, date, author, ...msg] = line.split("|");
    return { name: name.replace("origin/", ""), date, author, message: msg.join("|") };
  }).filter(b => {
    const d = new Date(b.date);
    return d < cutoff && !["main", "master", "production"].includes(b.name);
  });

  return { staleDays: days, count: stale.length, branches: stale };
});
