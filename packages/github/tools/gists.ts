/**
 * GitHub Gists — Code snippet sharing and collaboration
 *
 * Create, list, view, edit, fork, and delete gists.
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

// ── List Gists ─────────────────────────────────────────────

registerTool({
  name: "gh_gist_list",
  description: "List your GitHub gists (public and secret).",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max gists (default: 10)" },
      public: { type: "boolean", description: "Only show public gists" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { limit = 10 } = input as { limit?: number; public?: boolean };
  const result = gh(ctx).exec(`gist list --limit ${limit}`);
  return { gists: result };
});

// ── View Gist ──────────────────────────────────────────────

registerTool({
  name: "gh_gist_view",
  description: "View a gist's content. Returns all files in the gist.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Gist ID or URL" },
      file: { type: "string", description: "Specific filename to view (shows all if omitted)" },
    },
    required: ["id"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { id, file } = input as { id: string; file?: string };
  let cmd = `gist view ${id} --raw`;
  if (file) cmd += ` --filename "${file}"`;
  const content = gh(ctx).exec(cmd);
  return { id, file, content: content.slice(0, 20000), truncated: content.length > 20000 };
});

// ── Create Gist ────────────────────────────────────────────

registerTool({
  name: "gh_gist_create",
  description: "Create a new gist from files or stdin. Supports multiple files, public/secret, and descriptions.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" }, description: "File paths to include in the gist" },
      description: { type: "string", description: "Gist description" },
      public: { type: "boolean", description: "Make gist public (default: false = secret)" },
      filename: { type: "string", description: "Filename when creating from content" },
      content: { type: "string", description: "Content to use instead of files (creates single-file gist)" },
    },
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { files, description, public: isPublic = false, filename, content } = input as {
    files?: string[]; description?: string; public?: boolean; filename?: string; content?: string;
  };
  const client = gh(ctx);

  if (content) {
    // Create from content via stdin pipe
    const { execSync } = await import("child_process");
    const fname = filename || "snippet.txt";
    let cmd = `echo ${JSON.stringify(content)} | gh gist create --filename "${fname}"`;
    if (description) cmd += ` --desc "${description.replace(/"/g, '\\"')}"`;
    if (isPublic) cmd += " --public";
    const result = execSync(cmd, { cwd: ctx.workingDirectory, encoding: "utf-8", timeout: 30000 }).trim();
    return { success: true, url: result };
  }

  if (files?.length) {
    let cmd = `gist create ${files.map(f => `"${f}"`).join(" ")}`;
    if (description) cmd += ` --desc "${description.replace(/"/g, '\\"')}"`;
    if (isPublic) cmd += " --public";
    const result = client.exec(cmd);
    return { success: true, url: result };
  }

  return { success: false, error: "Provide either 'files' or 'content'" };
});

// ── Edit Gist ──────────────────────────────────────────────

registerTool({
  name: "gh_gist_edit",
  description: "Edit an existing gist — add or update files.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Gist ID" },
      addFile: { type: "string", description: "Path to file to add" },
      filename: { type: "string", description: "Filename to update" },
      description: { type: "string", description: "New description" },
    },
    required: ["id"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { id, addFile, filename, description } = input as {
    id: string; addFile?: string; filename?: string; description?: string;
  };
  const client = gh(ctx);
  let cmd = `gist edit ${id}`;
  if (addFile) cmd += ` --add "${addFile}"`;
  if (filename) cmd += ` --filename "${filename}"`;
  if (description) cmd += ` --desc "${description.replace(/"/g, '\\"')}"`;
  const result = client.exec(cmd);
  return { success: true, id, result };
});

// ── Delete Gist ────────────────────────────────────────────

registerTool({
  name: "gh_gist_delete",
  description: "Delete a gist.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Gist ID" },
    },
    required: ["id"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { id } = input as { id: string };
  const result = gh(ctx).exec(`gist delete ${id} --yes`);
  return { success: true, id, result };
});

// ── Clone Gist ─────────────────────────────────────────────

registerTool({
  name: "gh_gist_clone",
  description: "Clone a gist to a local directory.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Gist ID" },
      dir: { type: "string", description: "Target directory (default: gist ID)" },
    },
    required: ["id"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { id, dir } = input as { id: string; dir?: string };
  let cmd = `gist clone ${id}`;
  if (dir) cmd += ` "${dir}"`;
  const result = gh(ctx).exec(cmd);
  return { success: true, id, dir, result };
});
