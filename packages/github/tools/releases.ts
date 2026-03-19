/**
 * GitHub Releases — Version management and asset distribution
 *
 * Create, list, view, edit, delete releases. Upload and download assets.
 */

import { registerTool } from "../../toolshed/registry/register";
import type { ExecutionContext } from "../../types";
import { getGitHubClient } from "../client";

function gh(ctx: ExecutionContext) {
  return getGitHubClient({ cwd: ctx.workingDirectory });
}

// ── List Releases ──────────────────────────────────────────

registerTool({
  name: "gh_release_list",
  description: "List releases for the repository, including drafts and pre-releases.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max releases (default: 10)" },
    },
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { limit = 10 } = input as { limit?: number };
  const result = gh(ctx).exec(`release list --limit ${limit}`);
  return { releases: result };
});

// ── View Release ───────────────────────────────────────────

registerTool({
  name: "gh_release_view",
  description: "View a specific release with body, assets, and metadata.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Release tag (e.g., 'v1.0.0'). Use 'latest' for most recent." },
    },
    required: ["tag"],
  },
  permissions: ["github:read"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { tag } = input as { tag: string };
  const result = gh(ctx).exec(`release view ${tag}`);
  return { tag, details: result };
});

// ── Create Release ─────────────────────────────────────────

registerTool({
  name: "gh_release_create",
  description: "Create a new GitHub release with tag, title, notes, and optional asset uploads.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Release tag (e.g., 'v1.0.0')" },
      title: { type: "string", description: "Release title" },
      notes: { type: "string", description: "Release notes (markdown)" },
      draft: { type: "boolean", description: "Create as draft (default: false)" },
      prerelease: { type: "boolean", description: "Mark as pre-release (default: false)" },
      target: { type: "string", description: "Target branch or commit SHA (default: default branch)" },
      generateNotes: { type: "boolean", description: "Auto-generate release notes from commits (default: false)" },
      assets: { type: "array", items: { type: "string" }, description: "File paths to upload as release assets" },
      latest: { type: "boolean", description: "Mark as latest release (default: true)" },
    },
    required: ["tag"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { tag, title, notes, draft, prerelease, target, generateNotes, assets, latest = true } = input as {
    tag: string; title?: string; notes?: string; draft?: boolean; prerelease?: boolean;
    target?: string; generateNotes?: boolean; assets?: string[]; latest?: boolean;
  };
  const client = gh(ctx);

  let cmd = `release create ${tag}`;
  if (title) cmd += ` --title "${title.replace(/"/g, '\\"')}"`;
  if (notes) cmd += ` --notes "${notes.replace(/"/g, '\\"')}"`;
  if (draft) cmd += " --draft";
  if (prerelease) cmd += " --prerelease";
  if (target) cmd += ` --target ${target}`;
  if (generateNotes) cmd += " --generate-notes";
  if (!latest) cmd += " --latest=false";
  if (assets?.length) cmd += " " + assets.map(a => `"${a}"`).join(" ");

  const result = client.exec(cmd);
  return { success: true, tag, url: result };
});

// ── Edit Release ───────────────────────────────────────────

registerTool({
  name: "gh_release_edit",
  description: "Edit an existing release's title, notes, draft/prerelease status.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Release tag" },
      title: { type: "string", description: "New title" },
      notes: { type: "string", description: "New release notes" },
      draft: { type: "boolean", description: "Set draft status" },
      prerelease: { type: "boolean", description: "Set prerelease status" },
      latest: { type: "boolean", description: "Set as latest" },
    },
    required: ["tag"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { tag, title, notes, draft, prerelease, latest } = input as {
    tag: string; title?: string; notes?: string; draft?: boolean; prerelease?: boolean; latest?: boolean;
  };
  const client = gh(ctx);
  let cmd = `release edit ${tag}`;
  if (title) cmd += ` --title "${title.replace(/"/g, '\\"')}"`;
  if (notes) cmd += ` --notes "${notes.replace(/"/g, '\\"')}"`;
  if (draft !== undefined) cmd += draft ? " --draft" : " --draft=false";
  if (prerelease !== undefined) cmd += prerelease ? " --prerelease" : " --prerelease=false";
  if (latest !== undefined) cmd += latest ? " --latest" : " --latest=false";
  const result = client.exec(cmd);
  return { success: true, tag, result };
});

// ── Delete Release ─────────────────────────────────────────

registerTool({
  name: "gh_release_delete",
  description: "Delete a release. Optionally delete the associated tag.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Release tag" },
      deleteTag: { type: "boolean", description: "Also delete the git tag (default: false)" },
    },
    required: ["tag"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { tag, deleteTag = false } = input as { tag: string; deleteTag?: boolean };
  let cmd = `release delete ${tag} --yes`;
  if (deleteTag) cmd += " --cleanup-tag";
  const result = gh(ctx).exec(cmd);
  return { success: true, tag, tagDeleted: deleteTag, result };
});

// ── Upload Assets ──────────────────────────────────────────

registerTool({
  name: "gh_release_upload",
  description: "Upload assets to an existing release.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Release tag" },
      files: { type: "array", items: { type: "string" }, description: "File paths to upload" },
      clobber: { type: "boolean", description: "Overwrite existing assets with same name (default: false)" },
    },
    required: ["tag", "files"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { tag, files, clobber = false } = input as { tag: string; files: string[]; clobber?: boolean };
  let cmd = `release upload ${tag} ${files.map(f => `"${f}"`).join(" ")}`;
  if (clobber) cmd += " --clobber";
  const result = gh(ctx).exec(cmd);
  return { success: true, tag, uploaded: files, result };
});

// ── Download Assets ────────────────────────────────────────

registerTool({
  name: "gh_release_download",
  description: "Download assets from a release.",
  capabilities: ["github"],
  inputSchema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Release tag (or 'latest')" },
      patterns: { type: "array", items: { type: "string" }, description: "Glob patterns to filter assets" },
      dir: { type: "string", description: "Download directory (default: .)" },
    },
    required: ["tag"],
  },
  permissions: ["github:write"],
}, async (input: unknown, ctx: ExecutionContext) => {
  const { tag, patterns, dir = "." } = input as { tag: string; patterns?: string[]; dir?: string };
  let cmd = `release download ${tag} --dir "${dir}"`;
  if (patterns?.length) {
    for (const p of patterns) cmd += ` --pattern "${p}"`;
  }
  const result = gh(ctx).exec(cmd);
  return { success: true, tag, dir, result };
});
