/**
 * GitHub Repository — Repo-level operations
 *
 * Stats, contributors, topics, labels, milestones, code search, notifications.
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

// ── Repo Info ──────────────────────────────────────────────

registerTool({
  name: "gh_repo_view",
  description: "View repository information: description, stars, forks, language, license, visibility, topics.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository (owner/name). Omit for current repo." },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { repo } = input as { repo?: string };
  const ref = repo || "";
  return gh(ctx).json(`repo view ${ref} --json name,owner,description,url,homepageUrl,stargazerCount,forkCount,watchers,primaryLanguage,licenseInfo,isPrivate,isFork,isArchived,defaultBranchRef,diskUsage,createdAt,updatedAt,repositoryTopics`);
});

// ── Repo Contributors ──────────────────────────────────────

registerTool({
  name: "gh_repo_contributors",
  description: "List top contributors to the repository with commit counts.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max contributors (default: 20)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { limit = 20 } = input as { limit?: number };
  const client = gh(ctx);
  const repo = client.getRepo();
  if (!repo) return { error: "Not in a GitHub repository" };
  try {
    const contributors = client.api<any[]>(`repos/${repo.full}/contributors?per_page=${limit}`);
    return {
      repo: repo.full,
      contributors: contributors.map(c => ({
        login: c.login,
        contributions: c.contributions,
        url: c.html_url,
      })),
    };
  } catch (err: any) {
    return { error: err.message };
  }
});

// ── List Labels ────────────────────────────────────────────

registerTool({
  name: "gh_label_list",
  description: "List all labels in the repository.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {},
  },
  permissions: ["github:read"],
}, async (_input: unknown, ctx: ExecutionContext) => {
  return { labels: gh(ctx).json("label list --json name,description,color") };
});

// ── Create Label ───────────────────────────────────────────

registerTool({
  name: "gh_label_create",
  description: "Create a new label in the repository.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Label name" },
      description: { type: "string", description: "Label description" },
      color: { type: "string", description: "Hex color without # (e.g., 'ff0000')" },
    },
    required: ["name"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { name, description, color } = input as { name: string; description?: string; color?: string };
  let cmd = `label create "${name}"`;
  if (description) cmd += ` --description "${description.replace(/"/g, '\\"')}"`;
  if (color) cmd += ` --color ${color}`;
  const result = gh(ctx).exec(cmd);
  return { success: true, name, result };
});

// ── Milestones ─────────────────────────────────────────────

registerTool({
  name: "gh_milestone_list",
  description: "List milestones in the repository.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "'open', 'closed', or 'all' (default: open)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { state = "open" } = input as { state?: string };
  const client = gh(ctx);
  const repo = client.getRepo();
  if (!repo) return { error: "Not in a GitHub repository" };
  try {
    const milestones = client.api<any[]>(`repos/${repo.full}/milestones?state=${state}`);
    return {
      milestones: milestones.map(m => ({
        number: m.number,
        title: m.title,
        state: m.state,
        description: m.description,
        openIssues: m.open_issues,
        closedIssues: m.closed_issues,
        dueOn: m.due_on,
        url: m.html_url,
      })),
    };
  } catch (err: any) {
    return { error: err.message };
  }
});

// ── GitHub Code Search ─────────────────────────────────────

registerTool({
  name: "gh_search_code",
  description: "Search code across GitHub repositories. Find implementations, patterns, and examples.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (GitHub code search syntax)" },
      repo: { type: "string", description: "Limit to specific repo (owner/name)" },
      language: { type: "string", description: "Filter by language" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { query, repo, language, limit = 10 } = input as {
    query: string; repo?: string; language?: string; limit?: number;
  };
  let cmd = `search code "${query.replace(/"/g, '\\"')}" --limit ${limit} --json repository,path,textMatches`;
  if (repo) cmd += ` --repo ${repo}`;
  if (language) cmd += ` --language ${language}`;
  try {
    return { query, results: gh(ctx).json(cmd) };
  } catch {
    // Fallback to text output
    return { query, results: gh(ctx).exec(cmd.replace(" --json repository,path,textMatches", "")) };
  }
});

// ── Search Repos ───────────────────────────────────────────

registerTool({
  name: "gh_search_repos",
  description: "Search GitHub repositories by name, description, topics, stars, language.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      language: { type: "string", description: "Filter by language" },
      sort: { type: "string", description: "'stars', 'forks', 'help-wanted-issues', 'updated' (default: best-match)" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { query, language, sort, limit = 10 } = input as {
    query: string; language?: string; sort?: string; limit?: number;
  };
  let cmd = `search repos "${query.replace(/"/g, '\\"')}" --limit ${limit} --json fullName,description,stargazersCount,forksCount,language,url,isPrivate,updatedAt`;
  if (language) cmd += ` --language ${language}`;
  if (sort) cmd += ` --sort ${sort}`;
  try {
    return { query, results: gh(ctx).json(cmd) };
  } catch {
    return { query, results: gh(ctx).exec(cmd.replace(" --json fullName,description,stargazersCount,forksCount,language,url,isPrivate,updatedAt", "")) };
  }
});

// ── Notifications ──────────────────────────────────────────

registerTool({
  name: "gh_notifications",
  description: "View GitHub notifications: PR reviews requested, issue mentions, CI failures, etc.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max notifications (default: 20)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { limit = 20 } = input as { limit?: number };
  const client = gh(ctx);
  try {
    const notifs = client.api<any[]>(`notifications?per_page=${limit}`);
    return {
      count: notifs.length,
      notifications: notifs.map(n => ({
        id: n.id,
        reason: n.reason,
        subject: n.subject?.title,
        type: n.subject?.type,
        repo: n.repository?.full_name,
        unread: n.unread,
        updatedAt: n.updated_at,
        url: n.subject?.url,
      })),
    };
  } catch (err: any) {
    return { error: err.message };
  }
});

// ── Mark Notifications Read ────────────────────────────────

registerTool({
  name: "gh_notifications_read",
  description: "Mark GitHub notifications as read.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      all: { type: "boolean", description: "Mark all as read (default: true)" },
      threadId: { type: "string", description: "Mark specific notification thread ID as read" },
    },
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { all = true, threadId } = input as { all?: boolean; threadId?: string };
  const client = gh(ctx);
  try {
    if (threadId) {
      client.api(`notifications/threads/${threadId}`, { method: "PATCH" });
      return { success: true, marked: threadId };
    }
    if (all) {
      client.api("notifications", { method: "PUT" });
      return { success: true, marked: "all" };
    }
    return { success: false, error: "Specify threadId or all:true" };
  } catch (err: any) {
    return { error: err.message };
  }
});

// ── Fork Repo ──────────────────────────────────────────────

registerTool({
  name: "gh_repo_fork",
  description: "Fork a repository to your account or an organization.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository to fork (owner/name)" },
      org: { type: "string", description: "Fork to an organization (default: your account)" },
      clone: { type: "boolean", description: "Clone the fork locally (default: false)" },
    },
    required: ["repo"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { repo, org, clone = false } = input as { repo: string; org?: string; clone?: boolean };
  let cmd = `repo fork ${repo}`;
  if (org) cmd += ` --org ${org}`;
  if (clone) cmd += " --clone";
  const result = gh(ctx).exec(cmd);
  return { success: true, forked: repo, result };
});

// ── Clone Repo ─────────────────────────────────────────────

registerTool({
  name: "gh_repo_clone",
  description: "Clone a GitHub repository.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository to clone (owner/name or URL)" },
      dir: { type: "string", description: "Target directory" },
    },
    required: ["repo"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { repo, dir } = input as { repo: string; dir?: string };
  let cmd = `repo clone ${repo}`;
  if (dir) cmd += ` "${dir}"`;
  const result = gh(ctx).exec(cmd);
  return { success: true, cloned: repo, result };
});
