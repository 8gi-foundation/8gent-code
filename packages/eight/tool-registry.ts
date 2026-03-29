/**
 * 8gent Code - Deferred Tool Registry
 *
 * Loads only core tools upfront + a discover_tools meta-tool.
 * When the model calls discover_tools(category), that category's
 * full schemas are added to the active set for the next turn.
 * Backward compat: pass allTools=true to load everything upfront.
 */
import { tool } from "ai";
import { z } from "zod";
import { agentTools, type AgentTools } from "../ai/tools";
import type { ToolSet } from "ai";

export const TOOL_CATEGORIES: Record<string, (keyof AgentTools)[]> = {
  core: ["read_file", "write_file", "edit_file", "run_command", "list_files",
         "get_outline", "get_symbol", "search_symbols"],
  git: ["git_status", "git_diff", "git_log", "git_add", "git_commit",
        "git_push", "git_branch", "git_checkout", "git_create_branch"],
  github: ["gh_pr_list", "gh_pr_create", "gh_pr_view", "gh_issue_list", "gh_issue_create"],
  web: ["web_search", "web_fetch"],
  lsp: ["lsp_goto_definition", "lsp_find_references", "lsp_hover", "lsp_document_symbols"],
  media: ["read_image", "describe_image", "read_pdf", "read_pdf_page",
          "read_notebook", "notebook_edit_cell", "notebook_insert_cell", "notebook_delete_cell"],
  orchestration: ["spawn_agent", "check_agent", "list_agents",
                  "suggest_spawn", "check_agents", "message_agent", "merge_agent_work"],
  background: ["background_start", "background_status", "background_output"],
  mcp: ["mcp_list_tools", "mcp_call_tool"],
};

const CATEGORY_NAMES = Object.keys(TOOL_CATEGORIES);

export class ToolRegistry {
  private activeTools: Map<string, ToolSet[string]> = new Map();
  private loadedCategories: Set<string> = new Set();

  constructor(allTools = false) {
    if (allTools) {
      for (const [name, def] of Object.entries(agentTools)) {
        this.activeTools.set(name, def);
      }
      this.loadedCategories = new Set(CATEGORY_NAMES);
    } else {
      this.loadCategory("core");
      this.activeTools.set("discover_tools", this.createDiscoverTool());
    }
  }

  /** Load a category's tools into the active set */
  loadCategory(category: string): string[] {
    const toolNames = TOOL_CATEGORIES[category];
    if (!toolNames) return [];
    const loaded: string[] = [];
    for (const name of toolNames) {
      if (!this.activeTools.has(name)) {
        const def = agentTools[name];
        if (def) { this.activeTools.set(name, def); loaded.push(name); }
      }
    }
    this.loadedCategories.add(category);
    return loaded;
  }

  /** Get the current active tool set for AI SDK */
  getTools(): ToolSet {
    return Object.fromEntries(this.activeTools) as ToolSet;
  }

  /** Register an external tool (e.g. from extensions) */
  registerExternalTool(name: string, handler: Function): void {
    this.activeTools.set(name, handler as ToolSet[string]);
  }

  /** Which categories are currently loaded */
  getLoadedCategories(): string[] {
    return [...this.loadedCategories];
  }

  /** List all available category names */
  static getCategories(): string[] {
    return CATEGORY_NAMES;
  }

  /** Create the discover_tools meta-tool */
  private createDiscoverTool() {
    const registry = this;
    return tool({
      description: `Load additional tool schemas by category. Available: ${CATEGORY_NAMES.join(", ")}. Core tools are already loaded. Call this to unlock a category before using its tools.`,
      parameters: z.object({
        category: z.string().describe(`Category to load. One of: ${CATEGORY_NAMES.join(", ")}`),
      }),
      execute: async ({ category }: { category: string }) => {
        if (!TOOL_CATEGORIES[category]) {
          return { error: `Unknown category "${category}". Available: ${CATEGORY_NAMES.join(", ")}` };
        }
        const loaded = registry.loadCategory(category);
        const allInCategory = TOOL_CATEGORIES[category] || [];
        return {
          category,
          loaded: loaded.length,
          tools: allInCategory,
          message: loaded.length > 0
            ? `Loaded ${loaded.length} tools: ${loaded.join(", ")}`
            : `Category "${category}" was already loaded.`,
        };
      },
    });
  }
}

/** Build the deferred-tool prompt segment listing available categories */
export function getDeferredToolSegment(): string {
  const lines = CATEGORY_NAMES.map((cat) => {
    const tools = TOOL_CATEGORIES[cat];
    return `- **${cat}**: ${tools.join(", ")}`;
  });
  return [
    "## TOOL CATEGORIES",
    "",
    "Core tools (file ops, code exploration, shell) are loaded.",
    "To use tools from other categories, call `discover_tools` first.",
    "",
    ...lines,
  ].join("\n");
}
