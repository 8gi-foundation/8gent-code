/**
 * GitHub Projects (v2) — Project board management
 *
 * List projects, view items, add/move items, update fields.
 * Uses `gh project` commands which interact with GitHub Projects v2 (GraphQL-based).
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

// ── List Projects ──────────────────────────────────────────

registerTool({
  name: "gh_project_list",
  description: "List GitHub Projects v2 for the current repo owner (user or org).",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "GitHub username or org (default: current repo owner)" },
      limit: { type: "number", description: "Max projects (default: 10)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { owner, limit = 10 } = input as { owner?: string; limit?: number };
  const client = gh(ctx);
  let cmd = `project list --limit ${limit} --format json`;
  if (owner) cmd += ` --owner ${owner}`;
  try {
    return { projects: client.json(cmd) };
  } catch {
    // Fallback to text output if JSON not supported
    return { projects: client.exec(cmd.replace(" --format json", "")) };
  }
});

// ── View Project ───────────────────────────────────────────

registerTool({
  name: "gh_project_view",
  description: "View a GitHub Project with its items, columns/status field, and metadata.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Project number" },
      owner: { type: "string", description: "Owner (default: current repo owner)" },
    },
    required: ["number"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, owner } = input as { number: number; owner?: string };
  const client = gh(ctx);
  let cmd = `project view ${number} --format json`;
  if (owner) cmd += ` --owner ${owner}`;
  try {
    return client.json(cmd);
  } catch {
    return { details: client.exec(cmd.replace(" --format json", "")) };
  }
});

// ── List Project Items ─────────────────────────────────────

registerTool({
  name: "gh_project_items",
  description: "List items in a GitHub Project with their status, assignees, and linked issues/PRs.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Project number" },
      owner: { type: "string", description: "Owner (default: current repo owner)" },
      limit: { type: "number", description: "Max items (default: 30)" },
    },
    required: ["number"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, owner, limit = 30 } = input as { number: number; owner?: string; limit?: number };
  const client = gh(ctx);
  let cmd = `project item-list ${number} --limit ${limit} --format json`;
  if (owner) cmd += ` --owner ${owner}`;
  try {
    return { items: client.json(cmd) };
  } catch {
    return { items: client.exec(cmd.replace(" --format json", "")) };
  }
});

// ── Add Item to Project ────────────────────────────────────

registerTool({
  name: "gh_project_add",
  description: "Add an issue or PR to a GitHub Project.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "number", description: "Project number" },
      url: { type: "string", description: "Issue or PR URL to add" },
      owner: { type: "string", description: "Project owner" },
    },
    required: ["number", "url"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { number, url, owner } = input as { number: number; url: string; owner?: string };
  const client = gh(ctx);
  let cmd = `project item-add ${number} --url ${url}`;
  if (owner) cmd += ` --owner ${owner}`;
  const result = client.exec(cmd);
  return { success: true, project: number, added: url, result };
});

// ── Edit Project Item Field ────────────────────────────────

registerTool({
  name: "gh_project_edit_item",
  description: "Edit a field value on a project item (e.g., change Status to 'Done', set Priority).",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      projectNumber: { type: "number", description: "Project number" },
      itemId: { type: "string", description: "Item ID (from project items list)" },
      fieldName: { type: "string", description: "Field name (e.g., 'Status', 'Priority')" },
      value: { type: "string", description: "New value for the field" },
      owner: { type: "string", description: "Project owner" },
    },
    required: ["projectNumber", "itemId", "fieldName", "value"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { projectNumber, itemId, fieldName, value, owner } = input as {
    projectNumber: number; itemId: string; fieldName: string; value: string; owner?: string;
  };
  const client = gh(ctx);
  let cmd = `project item-edit --project-id ${projectNumber} --id ${itemId} --field-id ${fieldName} --text "${value}"`;
  if (owner) cmd += ` --owner ${owner}`;
  const result = client.exec(cmd);
  return { success: true, project: projectNumber, item: itemId, field: fieldName, value, result };
});

// ── Create Project ─────────────────────────────────────────

registerTool({
  name: "gh_project_create",
  description: "Create a new GitHub Project v2.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Project title" },
      owner: { type: "string", description: "Owner (user or org)" },
    },
    required: ["title"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { title, owner } = input as { title: string; owner?: string };
  const client = gh(ctx);
  let cmd = `project create --title "${title.replace(/"/g, '\\"')}"`;
  if (owner) cmd += ` --owner ${owner}`;
  const result = client.exec(cmd);
  return { success: true, title, result };
});
