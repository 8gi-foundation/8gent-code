/**
 * 8gent AI - Toolshed Bridge
 *
 * Registers AI SDK tools into the toolshed registry so that
 * the planner and other packages can discover them via capability queries.
 *
 * Uses the functional API from toolshed/registry/register.ts since
 * the ToolRegistry class doesn't expose a public `has()` method.
 */

import { agentTools } from "./tools";
import type { Capability, Permission, ToolRegistration } from "../types";

/** Map AI SDK tool names to typed toolshed capabilities */
const TOOL_CAPABILITIES: Record<string, Capability[]> = {
  // Code exploration
  get_outline: ["code", "code.ast"],
  get_symbol: ["code", "code.symbol"],
  search_symbols: ["code", "code.symbol"],

  // File operations
  read_file: ["code"],
  write_file: ["code"],
  edit_file: ["code"],
  list_files: ["code"],

  // Git
  git_status: ["repo"],
  git_diff: ["repo"],
  git_log: ["repo"],
  git_add: ["repo"],
  git_commit: ["repo"],
  git_push: ["repo"],
  git_branch: ["repo"],
  git_checkout: ["repo"],
  git_create_branch: ["repo"],

  // GitHub CLI
  gh_pr_list: ["github"],
  gh_pr_create: ["github"],
  gh_pr_view: ["github"],
  gh_issue_list: ["github"],
  gh_issue_create: ["github"],

  // Shell
  run_command: ["execution"],

  // LSP
  lsp_goto_definition: ["code", "code.symbol"],
  lsp_find_references: ["code", "code.symbol"],
  lsp_hover: ["code", "code.symbol"],
  lsp_document_symbols: ["code", "code.symbol"],

  // Web
  web_search: ["execution"],
  web_fetch: ["execution"],
};

/** Map AI SDK tool names to typed toolshed permissions */
function getPermissionsForTool(name: string): Permission[] {
  if (name.startsWith("read_") || name.startsWith("get_") || name.startsWith("search_") || name.startsWith("list_") || name.startsWith("lsp_")) {
    return ["read:fs"];
  }
  if (name.startsWith("write_") || name.startsWith("edit_") || name.startsWith("notebook_")) {
    return ["read:fs", "write:fs"];
  }
  if (name.startsWith("git_")) {
    return ["read:fs", "write:fs", "exec:shell"];
  }
  if (name.startsWith("gh_")) {
    return ["read:fs", "exec:shell", "github:read", "github:write"];
  }
  if (name === "run_command" || name.startsWith("background_")) {
    return ["exec:shell"];
  }
  if (name.startsWith("web_") || name.startsWith("mcp_")) {
    return ["net:fetch"];
  }
  return ["read:fs"];
}

/**
 * Register all AI SDK tools into the toolshed registry.
 * Safe to call multiple times — skips already-registered tools.
 */
export async function registerToolsInToolshed(): Promise<{ registered: number; skipped: number }> {
  const { registerTool, hasTool } = await import("../toolshed/registry/register");

  let registered = 0;
  let skipped = 0;

  for (const [name, tool] of Object.entries(agentTools)) {
    if (hasTool(name)) {
      skipped++;
      continue;
    }

    const capabilities = TOOL_CAPABILITIES[name] || ["execution" as Capability];
    const permissions = getPermissionsForTool(name);

    const registration: ToolRegistration = {
      name,
      description: (tool as any).description || `AI SDK tool: ${name}`,
      capabilities,
      inputSchema: { type: "object" }, // Zod schema is on the tool, this is a placeholder for the registry
      permissions,
    };

    const executor = async (input: unknown) => {
      return (tool as any).execute(input);
    };

    registerTool(registration, executor);
    registered++;
  }

  return { registered, skipped };
}
