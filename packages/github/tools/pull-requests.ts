/**
 * GitHub Pull Requests — Full lifecycle management
 *
 * Review, approve, request changes, merge, check status, diff, comments.
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

// ── View PR ────────────────────────────────────────────────

registerTool({
  name: "gh_pr_view",
  description: "View a pull request with full details: body, reviews, checks, files changed, mergeable status.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number (omit for current branch PR)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number } = input as { number?: number };
  const client = gh(ctx);
  const ref = number ? String(number) : "";
  const fields = "number,title,state,body,author,labels,assignees,reviewRequests,reviews,headRefName,baseRefName,additions,deletions,changedFiles,mergeable,mergeStateStatus,statusCheckRollup,url,createdAt,updatedAt";
  return client.json(`pr view ${ref} --json ${fields}`);
});

// ── PR Diff ────────────────────────────────────────────────

registerTool({
  name: "gh_pr_diff",
  description: "Get the full diff of a pull request. Useful for code review.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
    },
    required: ["number"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number } = input as { number: number };
  const diff = gh(ctx).exec(`pr diff ${number}`);
  return { number, diff: diff.slice(0, 20000), truncated: diff.length > 20000, totalLength: diff.length };
});

// ── PR Files Changed ───────────────────────────────────────

registerTool({
  name: "gh_pr_files",
  description: "List files changed in a pull request with additions/deletions per file.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
    },
    required: ["number"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number } = input as { number: number };
  return gh(ctx).json(`pr view ${number} --json files`);
});

// ── PR Review ──────────────────────────────────────────────

registerTool({
  name: "gh_pr_review",
  description: "Submit a review on a pull request: approve, request changes, or comment.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
      action: { type: "string", description: "'approve', 'request-changes', or 'comment'" },
      body: { type: "string", description: "Review body/comment (required for request-changes)" },
    },
    required: ["number", "action"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, action, body } = input as { number: number; action: string; body?: string };
  const client = gh(ctx);
  let cmd = `pr review ${number} --${action}`;
  if (body) cmd += ` --body "${body.replace(/"/g, '\\"')}"`;
  const result = client.exec(cmd);
  return { success: true, pr: number, action, result };
});

// ── PR Comment ─────────────────────────────────────────────

registerTool({
  name: "gh_pr_comment",
  description: "Add a comment to a pull request.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
      body: { type: "string", description: "Comment body (markdown)" },
    },
    required: ["number", "body"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, body } = input as { number: number; body: string };
  const result = gh(ctx).exec(`pr comment ${number} --body "${body.replace(/"/g, '\\"')}"`);
  return { success: true, pr: number, result };
});

// ── Merge PR ───────────────────────────────────────────────

registerTool({
  name: "gh_pr_merge",
  description: "Merge a pull request. Supports merge, squash, or rebase strategies.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
      method: { type: "string", description: "'merge', 'squash', or 'rebase' (default: squash)" },
      deleteBranch: { type: "boolean", description: "Delete branch after merge (default: true)" },
      subject: { type: "string", description: "Custom merge commit subject" },
    },
    required: ["number"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, method = "squash", deleteBranch = true, subject } = input as {
    number: number; method?: string; deleteBranch?: boolean; subject?: string;
  };
  const client = gh(ctx);
  let cmd = `pr merge ${number} --${method}`;
  if (deleteBranch) cmd += " --delete-branch";
  if (subject) cmd += ` --subject "${subject.replace(/"/g, '\\"')}"`;
  const result = client.exec(cmd);
  return { success: true, pr: number, method, result };
});

// ── PR Checks ──────────────────────────────────────────────

registerTool({
  name: "gh_pr_checks",
  description: "View CI/CD check status for a pull request. Shows pass/fail/pending for each check.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
    },
    required: ["number"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number } = input as { number: number };
  const result = gh(ctx).exec(`pr checks ${number}`);
  return { pr: number, checks: result };
});

// ── Close PR ───────────────────────────────────────────────

registerTool({
  name: "gh_pr_close",
  description: "Close a pull request without merging.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
      comment: { type: "string", description: "Optional closing comment" },
      deleteBranch: { type: "boolean", description: "Delete the branch too (default: false)" },
    },
    required: ["number"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, comment, deleteBranch } = input as { number: number; comment?: string; deleteBranch?: boolean };
  const client = gh(ctx);
  let cmd = `pr close ${number}`;
  if (comment) cmd += ` --comment "${comment.replace(/"/g, '\\"')}"`;
  if (deleteBranch) cmd += " --delete-branch";
  const result = client.exec(cmd);
  return { success: true, pr: number, result };
});

// ── Ready for Review ───────────────────────────────────────

registerTool({
  name: "gh_pr_ready",
  description: "Mark a draft PR as ready for review.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "PR number" },
    },
    required: ["number"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number } = input as { number: number };
  const result = gh(ctx).exec(`pr ready ${number}`);
  return { success: true, pr: number, result };
});
