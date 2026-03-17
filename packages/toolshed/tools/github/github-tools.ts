/**
 * 8gent Toolshed - GitHub Tools
 *
 * Git and GitHub operations via shell commands.
 * Uses `gh` CLI for GitHub API and `git` for local operations.
 */

import { registerTool } from "../../registry/register";
import type { ExecutionContext } from "../../../types";
import { execSync } from "child_process";

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000 }).trim();
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

// ── git_status ──────────────────────────────────────

registerTool({
  name: "git_status",
  description: "Get git status: branch, staged/unstaged changes, untracked files.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {},
  },
  permissions: ["read:code"],
}, async (_input: unknown, ctx: ExecutionContext) => {
  const branch = run("git rev-parse --abbrev-ref HEAD", ctx.workingDirectory);
  const status = run("git status --porcelain", ctx.workingDirectory);
  const ahead = run("git rev-list --count @{u}..HEAD 2>/dev/null || echo 0", ctx.workingDirectory);
  const behind = run("git rev-list --count HEAD..@{u} 2>/dev/null || echo 0", ctx.workingDirectory);

  const lines = status.split("\n").filter(Boolean);
  const staged = lines.filter(l => l[0] !== " " && l[0] !== "?").length;
  const modified = lines.filter(l => l[1] === "M").length;
  const untracked = lines.filter(l => l.startsWith("??")).length;

  return {
    branch,
    staged,
    modified,
    untracked,
    ahead: parseInt(ahead),
    behind: parseInt(behind),
    clean: lines.length === 0,
    files: lines.slice(0, 20).map(l => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
  };
});

// ── git_diff ────────────────────────────────────────

registerTool({
  name: "git_diff",
  description: "Show git diff for staged or unstaged changes. Returns unified diff output.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "Show staged changes (--cached)" },
      file: { type: "string", description: "Specific file to diff" },
    },
  },
  permissions: ["read:code"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { staged, file } = input as { staged?: boolean; file?: string };
  let cmd = "git diff";
  if (staged) cmd += " --cached";
  if (file) cmd += ` -- ${file}`;
  const diff = run(cmd, ctx.workingDirectory);
  return { diff: diff.slice(0, 10000), truncated: diff.length > 10000 };
});

// ── git_log ─────────────────────────────────────────

registerTool({
  name: "git_log",
  description: "Show recent git commits with hash, author, date, and message.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      count: { type: "number", description: "Number of commits (default 10)" },
      file: { type: "string", description: "Filter by file path" },
    },
  },
  permissions: ["read:code"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { count = 10, file } = input as { count?: number; file?: string };
  let cmd = `git log --oneline --format='%H|%an|%ar|%s' -${count}`;
  if (file) cmd += ` -- ${file}`;
  const output = run(cmd, ctx.workingDirectory);
  const commits = output.split("\n").filter(Boolean).map(line => {
    const [hash, author, date, ...msg] = line.split("|");
    return { hash: hash?.slice(0, 8), author, date, message: msg.join("|") };
  });
  return { commits };
});

// ── git_commit ──────────────────────────────────────

registerTool({
  name: "git_commit",
  description: "Stage files and create a git commit.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Commit message" },
      files: { type: "array", items: { type: "string" }, description: "Files to stage (default: all modified)" },
    },
    required: ["message"],
  },
  permissions: ["write:code"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { message, files } = input as { message: string; files?: string[] };
  if (files && files.length > 0) {
    run(`git add ${files.map(f => `"${f}"`).join(" ")}`, ctx.workingDirectory);
  } else {
    run("git add -A", ctx.workingDirectory);
  }
  const result = run(`git commit -m "${message.replace(/"/g, '\\"')}"`, ctx.workingDirectory);
  const hash = run("git rev-parse --short HEAD", ctx.workingDirectory);
  return { hash, result };
});

// ── git_push ────────────────────────────────────────

registerTool({
  name: "git_push",
  description: "Push commits to remote. Creates upstream tracking if needed.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      setUpstream: { type: "boolean", description: "Set upstream with -u flag" },
    },
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { setUpstream } = input as { setUpstream?: boolean };
  const branch = run("git rev-parse --abbrev-ref HEAD", ctx.workingDirectory);
  const cmd = setUpstream ? `git push -u origin ${branch}` : "git push";
  const result = run(cmd, ctx.workingDirectory);
  return { branch, result };
});

// ── gh_pr_create ────────────────────────────────────

registerTool({
  name: "gh_pr_create",
  description: "Create a GitHub pull request using the gh CLI.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "PR title" },
      body: { type: "string", description: "PR body/description" },
      base: { type: "string", description: "Base branch (default: main)" },
      draft: { type: "boolean", description: "Create as draft PR" },
    },
    required: ["title"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { title, body, base, draft } = input as {
    title: string; body?: string; base?: string; draft?: boolean;
  };
  let cmd = `gh pr create --title "${title.replace(/"/g, '\\"')}"`;
  if (body) cmd += ` --body "${body.replace(/"/g, '\\"')}"`;
  if (base) cmd += ` --base ${base}`;
  if (draft) cmd += " --draft";
  const result = run(cmd, ctx.workingDirectory);
  return { url: result, title };
});

// ── gh_pr_list ──────────────────────────────────────

registerTool({
  name: "gh_pr_list",
  description: "List open pull requests on the current repository.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "PR state: open, closed, merged, all (default: open)" },
      limit: { type: "number", description: "Max PRs to return (default: 10)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { state = "open", limit = 10 } = input as { state?: string; limit?: number };
  const result = run(
    `gh pr list --state ${state} --limit ${limit} --json number,title,author,state,createdAt,url`,
    ctx.workingDirectory
  );
  return { prs: JSON.parse(result || "[]") };
});

// ── gh_issue_list ───────────────────────────────────

registerTool({
  name: "gh_issue_list",
  description: "List issues on the current repository.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Issue state: open, closed, all (default: open)" },
      limit: { type: "number", description: "Max issues (default: 10)" },
      label: { type: "string", description: "Filter by label" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { state = "open", limit = 10, label } = input as { state?: string; limit?: number; label?: string };
  let cmd = `gh issue list --state ${state} --limit ${limit} --json number,title,state,labels,createdAt,url`;
  if (label) cmd += ` --label "${label}"`;
  const result = run(cmd, ctx.workingDirectory);
  return { issues: JSON.parse(result || "[]") };
});
