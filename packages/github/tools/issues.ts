/**
 * GitHub Issues — Full lifecycle management
 *
 * Beyond list/create: view, comment, close, reopen, assign, label, pin, search.
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

// ── View Issue ─────────────────────────────────────────────

registerTool({
  name: "gh_issue_view",
  description: "View a specific GitHub issue with full details: body, labels, assignees, comments, timeline.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Issue number" },
      comments: { type: "boolean", description: "Include comments (default: true)" },
    },
    required: ["number"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, comments = true } = input as { number: number; comments?: boolean };
  const client = gh(ctx);

  const fields = "number,title,state,body,author,labels,assignees,milestone,createdAt,updatedAt,closedAt,url,reactionGroups";
  const issue = client.json<any>(`issue view ${number} --json ${fields}`);

  if (comments) {
    try {
      const commentData = client.json<any[]>(`issue view ${number} --json comments --jq '.comments'`);
      issue.comments = commentData?.slice(-20) || []; // Last 20 comments
    } catch {
      issue.comments = [];
    }
  }

  return issue;
});

// ── Comment on Issue ───────────────────────────────────────

registerTool({
  name: "gh_issue_comment",
  description: "Add a comment to a GitHub issue.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Issue number" },
      body: { type: "string", description: "Comment body (supports markdown)" },
    },
    required: ["number", "body"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, body } = input as { number: number; body: string };
  const client = gh(ctx);
  const result = client.exec(`issue comment ${number} --body "${body.replace(/"/g, '\\"')}"`);
  return { success: true, issue: number, result };
});

// ── Close/Reopen Issue ─────────────────────────────────────

registerTool({
  name: "gh_issue_close",
  description: "Close a GitHub issue. Optionally mark as completed or not-planned.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Issue number" },
      reason: { type: "string", description: "'completed' or 'not_planned' (default: completed)" },
      comment: { type: "string", description: "Optional closing comment" },
    },
    required: ["number"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, reason = "completed", comment } = input as { number: number; reason?: string; comment?: string };
  const client = gh(ctx);
  let cmd = `issue close ${number} --reason ${reason}`;
  if (comment) cmd += ` --comment "${comment.replace(/"/g, '\\"')}"`;
  const result = client.exec(cmd);
  return { success: true, issue: number, reason, result };
});

registerTool({
  name: "gh_issue_reopen",
  description: "Reopen a closed GitHub issue.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Issue number" },
    },
    required: ["number"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number } = input as { number: number };
  const result = gh(ctx).exec(`issue reopen ${number}`);
  return { success: true, issue: number, result };
});

// ── Assign/Unassign ────────────────────────────────────────

registerTool({
  name: "gh_issue_assign",
  description: "Assign or unassign users to/from a GitHub issue.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Issue number" },
      assignees: { type: "array", items: { type: "string" }, description: "GitHub usernames to assign" },
      remove: { type: "boolean", description: "Remove assignees instead of adding (default: false)" },
    },
    required: ["number", "assignees"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, assignees, remove = false } = input as { number: number; assignees: string[]; remove?: boolean };
  const client = gh(ctx);
  const flag = remove ? "--remove-assignee" : "--add-assignee";
  const result = client.exec(`issue edit ${number} ${flag} ${assignees.join(",")}`);
  return { success: true, issue: number, action: remove ? "unassigned" : "assigned", assignees, result };
});

// ── Label Issues ───────────────────────────────────────────

registerTool({
  name: "gh_issue_label",
  description: "Add or remove labels on a GitHub issue.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Issue number" },
      add: { type: "array", items: { type: "string" }, description: "Labels to add" },
      remove: { type: "array", items: { type: "string" }, description: "Labels to remove" },
    },
    required: ["number"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, add = [], remove = [] } = input as { number: number; add?: string[]; remove?: string[] };
  const client = gh(ctx);
  let cmd = `issue edit ${number}`;
  if (add.length) cmd += ` --add-label "${add.join(",")}"`;
  if (remove.length) cmd += ` --remove-label "${remove.join(",")}"`;
  const result = client.exec(cmd);
  return { success: true, issue: number, added: add, removed: remove, result };
});

// ── Search Issues ──────────────────────────────────────────

registerTool({
  name: "gh_issue_search",
  description: "Search issues across the current repo or all of GitHub. Supports qualifiers like is:open, label:bug, author:username.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (GitHub search syntax)" },
      limit: { type: "number", description: "Max results (default: 20)" },
      repo: { type: "string", description: "Specific repo (owner/name). Omit for current repo." },
    },
    required: ["query"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { query, limit = 20, repo } = input as { query: string; limit?: number; repo?: string };
  const client = gh(ctx);
  let cmd = `issue list --search "${query.replace(/"/g, '\\"')}" --limit ${limit} --json number,title,state,labels,author,createdAt,url`;
  if (repo) cmd = `issue list --repo ${repo} --search "${query.replace(/"/g, '\\"')}" --limit ${limit} --json number,title,state,labels,author,createdAt,url`;
  const results = client.json<any[]>(cmd);
  return { query, count: results.length, issues: results };
});

// ── Create Issue from Template ─────────────────────────────

registerTool({
  name: "gh_issue_create",
  description: "Create a GitHub issue with full options: title, body, labels, assignees, milestone, project.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body (markdown)" },
      labels: { type: "array", items: { type: "string" }, description: "Labels to apply" },
      assignees: { type: "array", items: { type: "string" }, description: "Assignees (GitHub usernames)" },
      milestone: { type: "string", description: "Milestone title or number" },
      project: { type: "string", description: "Project name to add to" },
    },
    required: ["title"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { title, body, labels, assignees, milestone, project } = input as {
    title: string; body?: string; labels?: string[]; assignees?: string[];
    milestone?: string; project?: string;
  };
  const client = gh(ctx);
  let cmd = `issue create --title "${title.replace(/"/g, '\\"')}"`;
  if (body) cmd += ` --body "${body.replace(/"/g, '\\"')}"`;
  if (labels?.length) cmd += ` --label "${labels.join(",")}"`;
  if (assignees?.length) cmd += ` --assignee "${assignees.join(",")}"`;
  if (milestone) cmd += ` --milestone "${milestone}"`;
  if (project) cmd += ` --project "${project}"`;
  const result = client.exec(cmd);
  return { success: true, url: result, title };
});
