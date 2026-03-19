/**
 * GitHub Actions — Workflow management and CI/CD interaction
 *
 * List workflows, trigger runs, view logs, download artifacts.
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

// ── List Workflows ─────────────────────────────────────────

registerTool({
  name: "gh_workflow_list",
  description: "List all GitHub Actions workflows in the repository.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      all: { type: "boolean", description: "Include disabled workflows (default: false)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { all = false } = input as { all?: boolean };
  const cmd = all ? "workflow list --all" : "workflow list";
  const result = gh(ctx).exec(cmd);
  return { workflows: result };
});

// ── View Workflow ──────────────────────────────────────────

registerTool({
  name: "gh_workflow_view",
  description: "View details of a specific workflow including recent runs.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      workflow: { type: "string", description: "Workflow name or filename (e.g., 'ci.yml')" },
    },
    required: ["workflow"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { workflow } = input as { workflow: string };
  const result = gh(ctx).exec(`workflow view "${workflow}"`);
  return { workflow, details: result };
});

// ── Trigger Workflow (workflow_dispatch) ────────────────────

registerTool({
  name: "gh_workflow_run",
  description: "Trigger a workflow_dispatch event to run a GitHub Actions workflow. The workflow must have on: workflow_dispatch configured.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      workflow: { type: "string", description: "Workflow name or filename" },
      ref: { type: "string", description: "Branch or tag to run on (default: default branch)" },
      inputs: { type: "object", description: "Workflow input parameters as key-value pairs" },
    },
    required: ["workflow"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { workflow, ref, inputs } = input as { workflow: string; ref?: string; inputs?: Record<string, string> };
  const client = gh(ctx);
  let cmd = `workflow run "${workflow}"`;
  if (ref) cmd += ` --ref ${ref}`;
  if (inputs) {
    for (const [k, v] of Object.entries(inputs)) {
      cmd += ` -f ${k}=${v}`;
    }
  }
  const result = client.exec(cmd);
  return { success: true, workflow, ref, result };
});

// ── List Runs ──────────────────────────────────────────────

registerTool({
  name: "gh_run_list",
  description: "List recent workflow runs. Filter by workflow, branch, status, or user.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      workflow: { type: "string", description: "Filter by workflow name/filename" },
      branch: { type: "string", description: "Filter by branch" },
      status: { type: "string", description: "'completed', 'in_progress', 'queued', 'failure', 'success'" },
      limit: { type: "number", description: "Max results (default: 10)" },
      user: { type: "string", description: "Filter by user who triggered" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { workflow, branch, status, limit = 10, user } = input as {
    workflow?: string; branch?: string; status?: string; limit?: number; user?: string;
  };
  const client = gh(ctx);
  let cmd = `run list --limit ${limit} --json databaseId,workflowName,status,conclusion,headBranch,event,createdAt,updatedAt,url`;
  if (workflow) cmd += ` --workflow "${workflow}"`;
  if (branch) cmd += ` --branch ${branch}`;
  if (status) cmd += ` --status ${status}`;
  if (user) cmd += ` --user ${user}`;
  return { runs: client.json(cmd) };
});

// ── View Run ───────────────────────────────────────────────

registerTool({
  name: "gh_run_view",
  description: "View a specific workflow run with job details and status.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "number", description: "Run ID" },
    },
    required: ["runId"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { runId } = input as { runId: number };
  const result = gh(ctx).json(`run view ${runId} --json databaseId,workflowName,status,conclusion,jobs,headBranch,event,createdAt,updatedAt,url`);
  return result;
});

// ── View Run Logs ──────────────────────────────────────────

registerTool({
  name: "gh_run_log",
  description: "View logs for a workflow run. Shows step-by-step output from all jobs.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "number", description: "Run ID" },
      failed: { type: "boolean", description: "Only show failed steps (default: false)" },
    },
    required: ["runId"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { runId, failed = false } = input as { runId: number; failed?: boolean };
  const cmd = failed ? `run view ${runId} --log-failed` : `run view ${runId} --log`;
  const logs = gh(ctx).exec(cmd);
  return { runId, logs: logs.slice(0, 30000), truncated: logs.length > 30000 };
});

// ── Re-run Workflow ────────────────────────────────────────

registerTool({
  name: "gh_run_rerun",
  description: "Re-run a workflow run. Can re-run only failed jobs.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "number", description: "Run ID to re-run" },
      failedOnly: { type: "boolean", description: "Only re-run failed jobs (default: false)" },
    },
    required: ["runId"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { runId, failedOnly = false } = input as { runId: number; failedOnly?: boolean };
  const cmd = failedOnly ? `run rerun ${runId} --failed` : `run rerun ${runId}`;
  const result = gh(ctx).exec(cmd);
  return { success: true, runId, failedOnly, result };
});

// ── Cancel Run ─────────────────────────────────────────────

registerTool({
  name: "gh_run_cancel",
  description: "Cancel an in-progress workflow run.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "number", description: "Run ID to cancel" },
    },
    required: ["runId"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { runId } = input as { runId: number };
  const result = gh(ctx).exec(`run cancel ${runId}`);
  return { success: true, runId, result };
});

// ── Download Artifacts ─────────────────────────────────────

registerTool({
  name: "gh_run_download",
  description: "Download artifacts from a workflow run.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "number", description: "Run ID" },
      name: { type: "string", description: "Specific artifact name (downloads all if omitted)" },
      dir: { type: "string", description: "Download directory (default: .)" },
    },
    required: ["runId"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { runId, name, dir = "." } = input as { runId: number; name?: string; dir?: string };
  const client = gh(ctx);
  let cmd = `run download ${runId} --dir "${dir}"`;
  if (name) cmd += ` --name "${name}"`;
  const result = client.exec(cmd);
  return { success: true, runId, dir, result };
});
