/**
 * 8gent Code - Tool Executor
 *
 * Defines all tools available to the agent and handles their execution.
 * This is the bridge between LLM tool calls and actual system operations.
 */

import * as fs from "fs";
import * as path from "path";
import { parseTypeScriptFile, getSymbolSource } from "../ast-index/typescript-parser";
import {
  indexFolder as astIndexFolder,
  getFileOutline as astGetFileOutline,
  getFileTree as astGetFileTree,
  listRepos as astListRepos,
  type RepoIndex,
} from "../ast-index";
import {
  getPermissionManager,
  isCommandDangerous,
  type PermissionManager,
} from "../permissions";
import { ToolG8 } from "../permissions/toolg8.js";
import type { PolicyActionType } from "../permissions/types.js";
import {
  getHookManager,
  type HookManager,
} from "../hooks";
import {
  readImage,
  describeImage,
} from "../tools/image";
// PDF tools - lazy loaded to avoid DOMMatrix issues
const readPdf = async (p: string) => { throw new Error("PDF support coming soon"); };
const readPdfPage = async (p: string, n: number) => { throw new Error("PDF support coming soon"); };
import {
  readNotebook,
  editCell,
  insertCell,
  deleteCell,
} from "../tools/notebook";
import {
  getMCPClient,
  formatToolResult,
} from "../mcp";
import {
  lspGoToDefinition,
  lspFindReferences,
  lspHover,
  lspDocumentSymbols,
  lspDiagnostics,
} from "../lsp";
import {
  webSearch,
  webFetch,
  formatSearchResults,
  formatFetchResult,
} from "../tools/web";
import {
  vercelListProjects,
  vercelGetDeployments,
  vercelDeploy,
  vercelSetEnv,
  vercelGetEnv,
  vercelListDomains,
  vercelGetDeploymentLogs,
} from "../tools/vercel";
import {
  getBackgroundTaskManager,
  formatTaskStatus,
  formatTaskOutput,
} from "../tools/background";
import {
  needsDesignDecision,
  detectDesignNeed,
  suggestDesignSystems,
  getAvailableDesignSystems,
} from "../design-agent/index.js";
import {
  initDatabase as initDesignDb,
  search as searchDesignSystems_db,
  suggestForProject as suggestDesignForProject,
  getComplete as getCompleteDesignSystem,
  findByStyle as findDesignByStyle,
  findByMood as findDesignByMood,
  generateCssVariables,
  generateTailwindConfig,
  getHexPalette,
  listAll as listAllDesignSystems,
  listStyles as listDesignStyles,
  listMoods as listDesignMoods,
} from "../design-systems/index.js";
import {
  parseDesignMd,
  lintDesignMd,
  importDesignMd,
  exportDesignMd,
  generateDesignSpec,
  generateDesignMd,
} from "../design-systems/design-md.js";
import { createInfiniteRunner, formatInfiniteState, type InfiniteRunner } from "../infinite";
import {
  browserOpen,
  browserState,
  browserScreenshot,
  browserTask,
} from "../tools/browser-use";
import {
  BrowserHarness,
  createBrowserHarness,
  type BrowserStrategy,
} from "../browser-harness";
import {
  PolymarketClient,
  TradingEngine,
  type TradeIntent,
  type StrategyConfig,
} from "../trading";
import { parseMarketArrays } from "../trading/polymarket/types";
import {
  screenshot as computerScreenshot,
  click as computerClick,
  typeText as computerType,
  press as computerPress,
  scroll as computerScroll,
  drag as computerDrag,
  hover as computerHover,
  mousePosition as computerMousePosition,
  windowList as computerWindowList,
  clipboardGet as computerClipboardGet,
  clipboardSet as computerClipboardSet,
  listProcesses as computerListProcesses,
  quitProcess as computerQuitProcess,
  quitByName as computerQuitByName,
  suggestQuittable as computerSuggestQuittable,
  loadSafeList as computerLoadSafeList,
  addToSafeList as computerAddToSafeList,
  removeFromSafeList as computerRemoveFromSafeList,
  imageToDesktop,
  decodeCoordMap,
  getToolDefinitions as getComputerToolDefs,
} from "../computer";
import { getMemoryManager } from "../memory";
import { RateLimiter } from "../tools/rate-limiter";

/**
 * Validate that a user-provided path stays within the working directory.
 * Prevents path traversal attacks (../../etc/passwd).
 * Always normalizes the raw input - no pre-processing should be done by callers.
 */
function safePath(userPath: string, workingDirectory: string): string {
  // Normalize first to collapse ../ sequences before resolving
  const normalized = path.normalize(userPath);
  const absolutePath = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workingDirectory, normalized);

  const normalizedBase = path.resolve(workingDirectory);
  const normalizedTarget = path.resolve(absolutePath);

  // Allow the working directory itself
  if (normalizedTarget === normalizedBase) return normalizedTarget;

  // Must be inside the working directory
  if (!normalizedTarget.startsWith(normalizedBase + path.sep)) {
    throw new Error(`Path traversal blocked: "${userPath}" resolves outside working directory`);
  }

  return normalizedTarget;
}

/**
 * Validate a shell command for dangerous metacharacters.
 * Blocks command chaining, command substitution, and background execution
 * while allowing safe operators like pipes and redirects.
 */
function sanitizeShellCommand(command: string): { safe: boolean; reason?: string } {
  // Block command substitution: $(...) and backticks
  if (/\$\(/.test(command)) {
    return { safe: false, reason: "Command substitution $(...) is not allowed" };
  }
  if (/`/.test(command)) {
    return { safe: false, reason: "Command substitution via backticks is not allowed" };
  }

  // Block semicolon chaining: ; cmd
  if (/;/.test(command)) {
    return { safe: false, reason: "Semicolon command chaining is not allowed. Use separate run_command calls instead" };
  }

  // Block && and || chaining
  if (/&&/.test(command)) {
    return { safe: false, reason: "Command chaining with && is not allowed. Use separate run_command calls instead" };
  }
  if (/\|\|/.test(command)) {
    return { safe: false, reason: "Command chaining with || is not allowed. Use separate run_command calls instead" };
  }

  // Block background execution: & at end of command (but not 2>&1 which is a redirect)
  // Match & that is NOT preceded by > (redirect) and NOT part of &&
  if (/(?<!>)&\s*$/.test(command)) {
    return { safe: false, reason: "Background execution (&) is not allowed" };
  }

  return { safe: true };
}

/**
 * Execute a git command safely using spawn with argument arrays.
 * Prevents shell injection from LLM-generated arguments.
 */
function spawnGit(args: string[], cwd: string): Promise<string> {
  return new Promise(async (resolve) => {
    const { spawn } = await import("child_process");
    const proc = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code: number | null) => {
      resolve(code === 0 ? stdout.trim() : `Error (exit ${code}): ${stderr.trim()}`);
    });
    proc.on("error", (err: Error) => resolve(`Error: ${err.message}`));
  });
}

export class ToolExecutor {
  private workingDirectory: string;
  private permissionManager: PermissionManager;
  private hookManager: HookManager;
  private toolG8: ToolG8;
  private agentId: string;
  private astIndexReady: boolean = false;
  private astRepoId: string | null = null;
  private astIndexPromise: Promise<RepoIndex> | null = null;

  constructor(workingDirectory: string = process.cwd(), agentId: string = "primary") {
    this.workingDirectory = workingDirectory;
    this.agentId = agentId;
    this.toolG8 = ToolG8.instance();
    this.permissionManager = getPermissionManager();
    this.hookManager = getHookManager();
    this.hookManager.setWorkingDirectory(workingDirectory);

    // Fire-and-forget AST indexing of the working directory
    this.astIndexPromise = astIndexFolder(this.workingDirectory).then((index) => {
      this.astIndexReady = true;
      this.astRepoId = index.id;
      return index;
    }).catch(() => {
      this.astIndexReady = false;
      return null as any;
    });
  }

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  /**
   * Get tool definitions for the LLM
   */
  getToolDefinitions(): object[] {
    return [
      // Code exploration
      {
        type: "function",
        function: {
          name: "get_outline",
          description: "[CODE] Returns a list of all symbols (functions, classes, types, exports) in a file with their line numbers and signatures. Use this FIRST before read_file to understand file structure - much cheaper than reading the whole file. Typically followed by get_symbol to extract just the function you need. If the file is not indexed, falls back to AST parsing.",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string", description: "Path to the file to analyze" }
            },
            required: ["filePath"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_symbol",
          description: "[CODE] Returns the full source code of a single symbol (function, class, variable, type) by ID. Use this after get_outline to extract exactly the code you need without reading the entire file. Typically used after get_outline or search_symbols. If the symbol is not found, check the ID format: 'path/to/file.ts::symbolName'.",
          parameters: {
            type: "object",
            properties: {
              symbolId: { type: "string", description: "Symbol ID in format 'path/to/file.ts::symbolName'" }
            },
            required: ["symbolId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "search_symbols",
          description: "[CODE] Returns matching symbol names, locations, and kinds across the entire indexed codebase. Use this when you know what you are looking for but not where it lives. Prefer this over reading multiple files to find a function. If no results, try broader query terms or check that the project is indexed with get_project_outline.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              kinds: { type: "array", items: { type: "string" }, description: "Filter by kinds: function, class, method, variable" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_project_outline",
          description: "[CODE] Returns a compact map of every indexed file in the project with symbol counts and names. Use this FIRST when starting work on an unfamiliar codebase to understand its structure. Much faster than listing directories and reading files individually. Follow up with get_outline on specific files of interest.",
          parameters: {
            type: "object",
            properties: {},
          }
        }
      },
      // File operations
      {
        type: "function",
        function: {
          name: "read_file",
          description: "[FILE] Returns the full text content of a file at the given path. Use when you need to see existing code before modifying it. For large files (>500 lines), prefer get_outline first to find the specific function, then get_symbol for just that code. For config files (package.json, tsconfig.json, etc.) this is the right choice directly.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the file to read" }
            },
            required: ["path"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description: "[FILE] Creates a new file or completely overwrites an existing file with the given content. Use when creating new files or rewriting an entire file. Prefer edit_file for surgical changes to existing files. ALWAYS use relative paths (e.g. 'server.ts', 'src/index.ts'). NEVER use absolute paths. If the parent directory does not exist, this will fail - use run_command to mkdir first.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Relative path to the file (e.g. 'server.ts', NOT '/project/server.ts')" },
              content: { type: "string", description: "Content to write" }
            },
            required: ["path", "content"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "edit_file",
          description: "[FILE] Returns confirmation after replacing an exact text match in a file with new text. Use this for surgical edits to existing files - prefer over write_file when changing a specific function or block. The oldText must match exactly (whitespace-sensitive). If the match fails, read_file first to get the exact current content, then retry.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the file" },
              oldText: { type: "string", description: "Text to find and replace" },
              newText: { type: "string", description: "Replacement text" }
            },
            required: ["path", "oldText", "newText"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_files",
          description: "[FILE] Returns a list of filenames and directories at the given path, optionally filtered by glob pattern. Use this to explore project structure or find files by name pattern. For finding files by content, use search_symbols or run_command with grep instead.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path (default: current directory)" },
              pattern: { type: "string", description: "Glob pattern to filter files" }
            }
          }
        }
      },
      // Git operations
      {
        type: "function",
        function: {
          name: "git_status",
          description: "[GIT] Returns the working tree status: modified, staged, untracked, and deleted files. Use this before git_add or git_commit to see what has changed. Also useful after edits to verify your changes landed in the right files.",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "git_diff",
          description: "[GIT] Returns the line-by-line diff of changes. Use without 'staged' to see unstaged working tree changes; use with staged=true to review what will be included in the next commit. Typically used after git_status to inspect specific changes before committing.",
          parameters: {
            type: "object",
            properties: {
              staged: { type: "boolean", description: "Show staged changes only" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "git_log",
          description: "[GIT] Returns recent commit hashes, messages, authors, and dates. Use this to understand project history, find when a change was introduced, or check commit message conventions before writing your own. Defaults to 10 commits.",
          parameters: {
            type: "object",
            properties: {
              count: { type: "number", description: "Number of commits to show (default: 10)" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "git_add",
          description: "[GIT] Stages files for the next commit. Use after making edits and before git_commit. Pass specific file paths to stage selectively, or omit to stage all changes. Typically used after git_status confirms the right files were modified.",
          parameters: {
            type: "object",
            properties: {
              files: { type: "string", description: "Files to add (default: all)" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "git_commit",
          description: "[GIT] Creates a git commit with the staged changes and returns the commit hash. Use after git_add. If nothing is staged, this will fail - run git_status first to verify staged files. Follow the project's commit message conventions (check git_log for examples).",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", description: "Commit message" }
            },
            required: ["message"]
          }
        }
      },
      // Shell
      {
        type: "function",
        function: {
          name: "run_command",
          description: "[SHELL] Executes a shell command and returns stdout/stderr. Use for: running tests, installing packages, checking versions, building projects, file operations (mkdir, mv, cp). Pipes (|) and redirects (>) are allowed. Command chaining (;, &&, ||) and background execution (&) are blocked for safety - use separate calls instead. If a command is blocked by permissions, simplify it or split into multiple calls.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Command to run" }
            },
            required: ["command"]
          }
        }
      },
      // Multi-agent orchestration
      {
        type: "function",
        function: {
          name: "spawn_agent",
          description: "[SHELL] Launches a background agent and returns an agentId for tracking. Use runtime='claude' for complex multi-step tasks needing a stronger model, runtime='8gent' for standard coding tasks, runtime='shell' for simple one-off commands. The agent runs asynchronously - use check_agent with the returned ID to poll for results. For 8gent runtime, pass model='auto:free' to auto-select the best free model.",
          parameters: {
            type: "object",
            properties: {
              task: { type: "string", description: "Task description for the background agent to execute" },
              runtime: { type: "string", enum: ["8gent", "claude", "shell"], description: "Runtime: '8gent' (default), 'claude' (Claude CLI), 'shell' (sh -c)" },
              model: { type: "string", description: "Model to use (only for 8gent runtime). Use 'auto:free' to automatically pick the best free model from OpenRouter." },
              timeout: { type: "number", description: "Timeout in ms (default: 5 min, only for claude/shell)" }
            },
            required: ["task"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "check_agent",
          description: "[SHELL] Returns the current status (running/completed/failed) and output of a background agent. Use this to poll a previously spawned agent by its ID. If status is 'running', wait and check again. Typically used after spawn_agent to collect results.",
          parameters: {
            type: "object",
            properties: {
              agentId: { type: "string", description: "Agent ID returned from spawn_agent" }
            },
            required: ["agentId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_agents",
          description: "[SHELL] Returns a summary of all spawned background agents with their IDs, runtimes, statuses, and elapsed times. Use this to get an overview before checking individual agents, or to find an agentId you lost track of.",
          parameters: { type: "object", properties: {} }
        }
      },
      // Web tools
      {
        type: "function",
        function: {
          name: "web_search",
          description: "[WEB] Returns a list of search results (titles, URLs, snippets) from DuckDuckGo. Use when you need to find documentation, look up error messages, or research a topic. Follow up with web_fetch on a specific result URL to get full page content. If results are poor, try rephrasing with more specific technical terms.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              maxResults: { type: "number", description: "Max results (default: 5)" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "web_fetch",
          description: "[WEB] Returns the text content of a web page at the given URL (HTML stripped to readable text). Use after web_search to read a specific page, or directly when you have a known URL (docs, GitHub, npm). Results are cached to disk. If the page is too large, only the first portion is returned.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to fetch" }
            },
            required: ["url"]
          }
        }
      },
      // Vercel deployment tools
      {
        type: "function",
        function: {
          name: "vercel_list_projects",
          description: "[DEPLOY] Returns all Vercel projects with IDs, names, frameworks, and last update times. Use this to discover project IDs needed by other vercel_ tools. Requires VERCEL_TOKEN env var.",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "vercel_get_deployments",
          description: "[DEPLOY] Returns recent deployments for a Vercel project including state, URL, and commit message. Use after vercel_list_projects to check deployment status.",
          parameters: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Vercel project ID" },
              limit: { type: "number", description: "Number of deployments to return (default: 5)" }
            },
            required: ["projectId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "vercel_deploy",
          description: "[DEPLOY] Triggers a redeployment of the latest deployment for a Vercel project. Returns the new deployment ID and URL.",
          parameters: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Vercel project ID" }
            },
            required: ["projectId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "vercel_set_env",
          description: "[DEPLOY] Creates or updates an environment variable on a Vercel project. Value is stored encrypted. Targets production, preview, and development by default.",
          parameters: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Vercel project ID" },
              key: { type: "string", description: "Environment variable name" },
              value: { type: "string", description: "Environment variable value" },
              target: { type: "array", items: { type: "string" }, description: "Targets: production, preview, development (default: all)" }
            },
            required: ["projectId", "key", "value"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "vercel_get_env",
          description: "[DEPLOY] Returns all environment variables for a Vercel project (keys and targets only, values are encrypted).",
          parameters: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Vercel project ID" }
            },
            required: ["projectId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "vercel_list_domains",
          description: "[DEPLOY] Returns all custom domains configured for a Vercel project with verification status.",
          parameters: {
            type: "object",
            properties: {
              projectId: { type: "string", description: "Vercel project ID" }
            },
            required: ["projectId"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "vercel_get_deployment_logs",
          description: "[DEPLOY] Returns build/runtime logs for a specific deployment. Use the deployment ID from vercel_get_deployments.",
          parameters: {
            type: "object",
            properties: {
              deploymentId: { type: "string", description: "Deployment ID (uid from vercel_get_deployments)" }
            },
            required: ["deploymentId"]
          }
        }
      },
      // Design tools
      {
        type: "function",
        function: {
          name: "suggest_design",
          description: "[DESIGN] Returns design system recommendations including color palettes, typography, and component libraries matched to your task. Use this BEFORE writing any UI code to get curated design guidance. Typically the first design tool to call - follow up with query_design_system for specific palette/component details. Prefer this over guessing colors or fonts.",
          parameters: {
            type: "object",
            properties: {
              task: { type: "string", description: "Description of the UI task or project (e.g., 'build a landing page', 'create a dashboard')" },
              projectType: { type: "string", description: "Optional project type hint: ai, saas, portfolio, ecommerce, dashboard, landing-page, etc." }
            },
            required: ["task"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "query_design_system",
          description: "[DESIGN] Returns design system data from a curated SQLite database - palettes, typography, components, and patterns. Use when you need specific design tokens (hex colors, font stacks, spacing scales). Can output as summary, CSS variables, Tailwind config, or hex palette. Typically used after suggest_design to get implementation-ready values for a recommended system.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query (e.g., 'minimal dark', 'claude', 'cyberpunk')" },
              style: { type: "string", description: "Filter by style: minimal, bold, playful, elegant, tech, retro, nature, corporate" },
              mood: { type: "string", description: "Filter by mood: professional, creative, tech, warm, cool, dramatic, calm, energetic" },
              output: { type: "string", description: "Output format: 'summary' (default), 'css' (CSS variables), 'tailwind' (Tailwind config), 'hex' (hex palette)" }
            }
          }
        }
      },
      // DESIGN.md format tools (design quality gate)
      {
        type: "function",
        function: {
          name: "lint_design_md",
          description: "[DESIGN] Validates a DESIGN.md file against the design.md spec. Checks token structure, color validity (hex), typography completeness, component token references, section order, WCAG contrast ratios, and duplicate sections. Returns findings with severity levels. Use this as a quality gate BEFORE shipping any UI - ensures design consistency regardless of which model generated the code.",
          parameters: {
            type: "object",
            properties: {
              content: { type: "string", description: "Raw DESIGN.md file content (YAML frontmatter + markdown)" },
              filePath: { type: "string", description: "Path to a DESIGN.md file to read and lint (alternative to content)" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "import_design_md",
          description: "[DESIGN] Imports a DESIGN.md file into the design systems database. Parses YAML tokens (colors, typography, spacing, components) and maps them to the 8gent schema. Once imported, the system is queryable via query_design_system and can be used to enforce design consistency across all UI work. Use this when the user provides a DESIGN.md file or URL.",
          parameters: {
            type: "object",
            properties: {
              content: { type: "string", description: "Raw DESIGN.md file content" },
              filePath: { type: "string", description: "Path to a DESIGN.md file to read and import" },
              style: { type: "string", description: "Override style classification: minimal, bold, playful, elegant, tech, retro, nature, corporate" },
              mood: { type: "string", description: "Override mood classification: professional, creative, tech, warm, cool, dramatic, calm, energetic" },
              tags: { type: "array", items: { type: "string" }, description: "Additional tags for searchability" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "export_design_md",
          description: "[DESIGN] Exports a design system from the database as a DESIGN.md file. Generates YAML frontmatter with color tokens, typography definitions, and component specs, plus markdown sections (Overview, Colors, Typography, Components, Do's and Don'ts). The output conforms to the design.md spec and can be shared with any agent or tool that supports the format.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Design system name or ID to export (e.g., 'claude', 'vercel', 'paws-and-paths')" },
              asSpec: { type: "boolean", description: "If true, wraps the DESIGN.md in a system-prompt-ready format with instructions for the model to follow the design tokens strictly" }
            },
            required: ["name"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "generate_design_md",
          description: "[DESIGN] Generates a complete DESIGN.md from a project name and description. Uses curated font pairings (13 presets: SaaS, fintech, AI, developer, creative, agency, etc.), color palettes per mood (professional, warm, tech, calm, energetic, dramatic), proper spacing scales, and component token specs. No design background required - describe what you're building and get a spec-compliant DESIGN.md with expert-level design decisions baked in. If a matching design system exists in the DB, exports that instead.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Project or brand name (e.g., 'FinFlow', 'Launchpad', 'PetPals')" },
              projectType: { type: "string", description: "Project type for font/color selection: saas, fintech, ai, developer, creative, agency, gaming, kids, health, wellness, education, luxury, ecommerce, food, coffee" },
              mood: { type: "string", description: "Visual mood: professional, warm, tech, calm, energetic, dramatic" },
              description: { type: "string", description: "Brief description of what the project is (used in the Overview section)" },
              darkMode: { type: "boolean", description: "Generate dark mode palette (defaults to true for tech/dramatic moods)" }
            },
            required: ["name"]
          }
        }
      },
      // Infinite mode
      {
        type: "function",
        function: {
          name: "enable_infinite_mode",
          description: "[SHELL] Activates autonomous looping execution for a task and returns a runner handle. The agent will iterate until the task is complete, recovering from errors automatically. Use this when a task is too large for a single pass - e.g., refactoring across many files, running repeated test-fix cycles, or multi-step research. Set maxIterations and maxTimeMs to bound execution. If the task can be done in one shot, prefer direct tool calls instead.",
          parameters: {
            type: "object",
            properties: {
              task: { type: "string", description: "The task to execute in infinite mode" },
              maxIterations: { type: "number", description: "Maximum iterations before stopping (default: 100)" },
              maxTimeMs: { type: "number", description: "Maximum time in ms before stopping (default: 30 minutes)" }
            },
            required: ["task"]
          }
        }
      },
      // Memory tools
      {
        type: "function",
        function: {
          name: "remember",
          description: "[MEMORY] Persists a fact to the specified memory layer and returns confirmation. Use 'session' for temporary context that disappears when the session ends. Use 'project' for facts about this codebase (persisted in .8gent/ - e.g., architecture decisions, user preferences for this repo). Use 'global' for cross-project knowledge (persisted in ~/.8gent/ - e.g., user's coding style, tool preferences). Keep facts concise and searchable. Pair with recall to retrieve later.",
          parameters: {
            type: "object",
            properties: {
              fact: { type: "string", description: "The fact to remember" },
              layer: { type: "string", enum: ["session", "project", "global"], description: "Memory layer: session (ephemeral), project (per-repo), global (cross-project)" }
            },
            required: ["fact", "layer"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "recall",
          description: "[MEMORY] Returns matching facts from all memory layers (session, project, global) ranked by relevance. Use this when you need context about the user, project conventions, past decisions, or previously learned information. Search with broad keywords first, then narrow down. If no results, try synonyms or related terms. Useful at the start of a task to check for prior context.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query - keywords to match against stored memories" },
              limit: { type: "number", description: "Max results to return (default: 10)" }
            },
            required: ["query"]
          }
        }
      },
      // Desktop Computer Use tools (Power #10)
      ...getComputerToolDefs(),
      // Browser Harness tools (CDP-first with fallback chain)
      {
        type: "function",
        function: {
          name: "browser_open",
          description: "Open a URL in a real browser via CDP (Chrome DevTools Protocol). Falls back to browser-use CLI or HTTP fetch. Returns page title, URL, text content, links, and form inputs.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to navigate to" },
              headless: { type: "boolean", description: "Run in headless mode (default: false locally, true on vessels)" },
              remote_ws_url: { type: "string", description: "Remote CDP WebSocket URL for vessel/cloud browsers" }
            },
            required: ["url"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_state",
          description: "Get the current browser page state: URL, title, text, links, inputs, and all interactive elements with CSS selectors.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_click",
          description: "Click an element by CSS selector (e.g. '#submit', 'button.primary', 'a[href=\"/login\"]') or by {x, y} coordinates.",
          parameters: {
            type: "object",
            properties: {
              selector: { type: "string", description: "CSS selector of the element to click" },
              x: { type: "number", description: "X coordinate (use with y instead of selector)" },
              y: { type: "number", description: "Y coordinate (use with x instead of selector)" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_type",
          description: "Type text into the focused element, or into a specific element by CSS selector.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Text to type" },
              selector: { type: "string", description: "CSS selector to focus before typing (optional)" }
            },
            required: ["text"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_eval",
          description: "Execute JavaScript in the browser page context. Returns the evaluated result.",
          parameters: {
            type: "object",
            properties: {
              expression: { type: "string", description: "JavaScript expression to evaluate" }
            },
            required: ["expression"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_screenshot",
          description: "Capture a screenshot of the current browser page. Returns base64 PNG data or saves to a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to save screenshot (if omitted, returns base64)" },
              format: { type: "string", description: "Image format: png (default) or jpeg" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_scroll",
          description: "Scroll the browser page up or down.",
          parameters: {
            type: "object",
            properties: {
              direction: { type: "string", description: "Scroll direction: 'up' or 'down' (default: down)" },
              amount: { type: "number", description: "Pixels to scroll (default: 400)" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_elements",
          description: "Get all interactive elements on the page (links, buttons, inputs, selects) with their CSS selectors, text, and attributes.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "browser_close",
          description: "Close the browser harness connection. Does not kill Chrome - just disconnects the CDP session.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },

      // Trading tools (Polymarket)
      {
        type: "function",
        function: {
          name: "trade_browse",
          description: "Browse Polymarket prediction markets. Shows trending markets with odds, volume, and liquidity. Use to discover trading opportunities.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query to filter markets (optional)" },
              limit: { type: "number", description: "Number of markets to return (default: 10)" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_market",
          description: "Get detailed info on a specific Polymarket market - orderbook, spread, volume, odds for each outcome.",
          parameters: {
            type: "object",
            properties: {
              market_id: { type: "string", description: "Polymarket market ID" }
            },
            required: ["market_id"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_opportunities",
          description: "Find the best trading opportunities on Polymarket based on volume, liquidity, and odds spread. Scored and ranked.",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Number of opportunities (default: 5)" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_buy",
          description: "Buy shares on a Polymarket prediction market. Requires market_id, outcome (Yes/No), size (USDC amount). Checks guardrails before execution.",
          parameters: {
            type: "object",
            properties: {
              market_id: { type: "string", description: "Polymarket market ID" },
              outcome: { type: "string", description: "Outcome to buy: 'Yes' or 'No'" },
              size: { type: "number", description: "Amount in USDC to spend" },
              price: { type: "number", description: "Limit price (0.01-0.99). If omitted, uses current ask." },
              confidence: { type: "number", description: "Your confidence in this outcome (0-1)" },
              reasoning: { type: "string", description: "Why you think this trade is good" }
            },
            required: ["market_id", "outcome", "size", "confidence", "reasoning"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_sell",
          description: "Sell shares on a Polymarket prediction market. Requires market_id, outcome (Yes/No), size.",
          parameters: {
            type: "object",
            properties: {
              market_id: { type: "string", description: "Polymarket market ID" },
              outcome: { type: "string", description: "Outcome to sell: 'Yes' or 'No'" },
              size: { type: "number", description: "Number of shares to sell" },
              price: { type: "number", description: "Limit price (0.01-0.99)" },
              reasoning: { type: "string", description: "Why selling" }
            },
            required: ["market_id", "outcome", "size"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_positions",
          description: "Show current Polymarket positions and P&L. Requires CLOB API credentials in env.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_balance",
          description: "Get USDC balance on Polymarket. Requires CLOB API credentials in env.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_strategy",
          description: "View or update the trading strategy config: max trade size, max exposure, confidence threshold, edge requirement, autonomous mode, rate limits.",
          parameters: {
            type: "object",
            properties: {
              max_trade_size: { type: "number", description: "Max USDC per trade" },
              max_exposure: { type: "number", description: "Max total USDC exposure" },
              min_confidence: { type: "number", description: "Min confidence to trade (0-1)" },
              min_edge: { type: "number", description: "Min edge to trade (0-1)" },
              autonomous: { type: "boolean", description: "Enable autonomous trading mode" },
              max_trades_per_hour: { type: "number", description: "Max trades per hour" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "trade_journal",
          description: "View the trade journal - history of all trades attempted, executed, and blocked.",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Number of entries (default: 20)" }
            }
          }
        }
      },
    ];
  }

  private rateLimiter = new RateLimiter();

  /**
   * Map tool names to policy action types for ToolG8 gate evaluation.
   */
  private static TOOL_ACTION_MAP: Record<string, PolicyActionType> = {
    read_file: "read_file",
    write_file: "write_file",
    edit_file: "write_file",
    delete_file: "delete_file",
    run_command: "run_command",
    git_push: "git_push",
    git_commit: "git_commit",
    web_search: "network_request",
    web_fetch: "network_request",
    vercel_list_projects: "network_request",
    vercel_get_deployments: "network_request",
    vercel_deploy: "network_request",
    vercel_set_env: "network_request",
    vercel_get_env: "network_request",
    vercel_list_domains: "network_request",
    vercel_get_deployment_logs: "network_request",
    browser_open: "network_request",
    browser_eval: "run_command",
    browser_click: "run_command",
    browser_type: "run_command",
    browser_screenshot: "read_file",
    trade_browse: "network_request",
    trade_market: "network_request",
    trade_opportunities: "network_request",
    trade_buy: "network_request",
    trade_sell: "network_request",
    trade_positions: "network_request",
    trade_balance: "network_request",
  };

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Rate limit check - prevents LLM loops from exhausting resources
    const rateLimitError = this.rateLimiter.check(toolName);
    if (rateLimitError) return rateLimitError;

    // ToolG8 gate - evaluate policy before execution
    const policyAction = ToolExecutor.TOOL_ACTION_MAP[toolName];
    if (policyAction) {
      const gateResult = this.toolG8.gate(this.agentId, policyAction, {
        path: args.path as string,
        content: args.content as string,
        command: args.command as string,
        branch: args.branch as string,
        url: args.url as string,
        key: args.key as string,
      });
      if (!gateResult.allowed) {
        const alt = gateResult.alternative ? ` Alternative: ${gateResult.alternative}` : "";
        return `[TOOLG8 BLOCKED] ${gateResult.reason}${alt}`;
      }
    }

    switch (toolName) {
      // Code exploration
      case "get_outline":
        return this.getOutline(args.filePath as string);
      case "get_symbol":
        return this.getSymbol(args.symbolId as string);
      case "search_symbols":
        return this.searchSymbols(args.query as string, args.kinds as string[]);
      case "get_project_outline":
        return this.getProjectOutline();

      // LSP tools
      case "lsp_goto_definition":
        return lspGoToDefinition(
          args.filePath as string,
          args.line as number,
          args.character as number,
          this.workingDirectory
        );
      case "lsp_find_references":
        return lspFindReferences(
          args.filePath as string,
          args.line as number,
          args.character as number,
          this.workingDirectory
        );
      case "lsp_hover":
        return lspHover(
          args.filePath as string,
          args.line as number,
          args.character as number,
          this.workingDirectory
        );
      case "lsp_document_symbols":
        return lspDocumentSymbols(args.filePath as string, this.workingDirectory);
      case "lsp_diagnostics":
        return lspDiagnostics(args.filePath as string, this.workingDirectory);

      // File operations (with path traversal protection)
      case "read_file": {
        const safe = safePath(args.path as string, this.workingDirectory);
        return this.readFile(safe);
      }
      case "write_file": {
        const safe = safePath(args.path as string, this.workingDirectory);
        return this.writeFile(safe, args.content as string);
      }
      case "edit_file": {
        const safe = safePath(args.path as string, this.workingDirectory);
        return this.editFile(safe, args.oldText as string, args.newText as string);
      }
      case "list_files":
        return this.listFiles(args.path as string, args.pattern as string);

      // Git operations
      case "git_status":
        return this.runCommand("git status");
      case "git_diff":
        return this.runCommand(args.staged ? "git diff --staged" : "git diff");
      case "git_log": {
        const count = Math.floor(Math.abs(Number(args.count) || 10));
        return spawnGit(["log", "--oneline", `-${count}`], this.workingDirectory);
      }
      case "git_branch":
        return spawnGit(["branch", "-a"], this.workingDirectory);
      case "git_checkout":
        return spawnGit(["checkout", String(args.branch)], this.workingDirectory);
      case "git_create_branch":
        return spawnGit(["checkout", "-b", String(args.branch)], this.workingDirectory);
      case "git_add": {
        const files = String(args.files || ".").split(/\s+/).filter(Boolean);
        return spawnGit(["add", ...files], this.workingDirectory);
      }
      case "git_commit":
        return spawnGit(["commit", "-m", String(args.message)], this.workingDirectory);
      case "git_push": {
        const pushArgs = ["push"];
        if (args.setUpstream) pushArgs.push("-u", "origin", "HEAD");
        return spawnGit(pushArgs, this.workingDirectory);
      }

      // GitHub CLI (spawn with arg arrays, no shell interpolation)
      case "gh_pr_list":
        return this.runCommand("gh pr list");
      case "gh_pr_create":
        return this.runSpawn("gh", ["pr", "create", "--title", String(args.title), "--body", String(args.body || "")]);
      case "gh_pr_view":
        return this.runSpawn("gh", ["pr", "view", String(args.number || "")]);
      case "gh_issue_list":
        return this.runCommand("gh issue list");
      case "gh_issue_create":
        return this.runSpawn("gh", ["issue", "create", "--title", String(args.title), "--body", String(args.body || "")]);

      // Shell
      case "run_command":
        return this.runCommand(args.command as string);

      // Multi-agent orchestration
      case "spawn_agent":
        return this.handleSpawnAgent(
          args.task as string,
          (args.runtime as "8gent" | "claude" | "shell" | undefined),
          args.model as string | undefined,
          args.timeout as number | undefined
        );
      case "check_agent":
        return this.handleCheckAgent(args.agentId as string);
      case "list_agents":
        return this.handleListAgents();

      // Image tools
      case "read_image":
        return this.handleReadImage(args.path as string);
      case "describe_image":
        return this.handleDescribeImage(args.path as string, args.prompt as string | undefined);

      // PDF tools
      case "read_pdf":
        return this.handleReadPdf(args.path as string);
      case "read_pdf_page":
        return this.handleReadPdfPage(args.path as string, args.pageNum as number);

      // Notebook tools
      case "read_notebook":
        return this.handleReadNotebook(args.path as string);
      case "notebook_edit_cell":
        return this.handleNotebookEditCell(
          args.path as string,
          args.cellIndex as number,
          args.newSource as string
        );
      case "notebook_insert_cell":
        return this.handleNotebookInsertCell(
          args.path as string,
          args.afterIndex as number,
          args.cellType as "code" | "markdown",
          args.source as string
        );
      case "notebook_delete_cell":
        return this.handleNotebookDeleteCell(args.path as string, args.cellIndex as number);

      // Web tools
      case "web_search":
        return this.handleWebSearch(args.query as string, args.maxResults as number);
      case "web_fetch":
        return this.handleWebFetch(args.url as string);

      // Vercel deployment tools
      case "vercel_list_projects":
        return vercelListProjects();
      case "vercel_get_deployments":
        return vercelGetDeployments(args.projectId as string, args.limit as number);
      case "vercel_deploy":
        return vercelDeploy(args.projectId as string);
      case "vercel_set_env":
        return vercelSetEnv(args.projectId as string, args.key as string, args.value as string, args.target as string[]);
      case "vercel_get_env":
        return vercelGetEnv(args.projectId as string);
      case "vercel_list_domains":
        return vercelListDomains(args.projectId as string);
      case "vercel_get_deployment_logs":
        return vercelGetDeploymentLogs(args.deploymentId as string);

      // MCP tools
      case "mcp_list_tools":
        return this.handleMCPListTools();
      case "mcp_call_tool":
        return this.handleMCPCallTool(
          args.server as string,
          args.tool as string,
          args.args as Record<string, unknown>
        );

      // Background task tools
      case "background_start":
        return this.handleBackgroundStart(args.command as string, args.timeout as number);
      case "background_status":
        return this.handleBackgroundStatus(args.taskId as string);
      case "background_output":
        return this.handleBackgroundOutput(args.taskId as string, args.tail as number);

      // Design tools
      case "suggest_design":
        return this.handleSuggestDesign(args.task as string, args.projectType as string | undefined);
      case "query_design_system":
        return this.handleQueryDesignSystem(args);
      case "lint_design_md":
        return this.handleLintDesignMd(args.content as string | undefined, args.filePath as string | undefined);
      case "import_design_md":
        return this.handleImportDesignMd(args);
      case "export_design_md":
        return this.handleExportDesignMd(args.name as string, args.asSpec as boolean | undefined);
      case "generate_design_md":
        return this.handleGenerateDesignMd(args);

      // Infinite mode
      case "enable_infinite_mode":
        return this.handleEnableInfiniteMode(
          args.task as string,
          args.maxIterations as number | undefined,
          args.maxTimeMs as number | undefined
        );

      // Memory tools
      case "remember":
        return this.handleRemember(args.fact as string, args.layer as "session" | "project" | "global");
      case "recall":
        return this.handleRecall(args.query as string, args.limit as number | undefined);

      // Desktop Computer Use tools (Power #10)
      case "desktop_screenshot":
        return this.handleDesktopScreenshot(args.path as string | undefined, args.displayId as number | undefined);
      case "desktop_click":
        return this.handleDesktopClick(args.x as number, args.y as number, args.button as string | undefined, args.count as number | undefined, args.coordMap as string | undefined);
      case "desktop_type":
        return this.handleDesktopType(args.text as string, args.delay as number | undefined);
      case "desktop_press":
        return this.handleDesktopPress(args.keys as string, args.count as number | undefined, args.delay as number | undefined);
      case "desktop_scroll":
        return this.handleDesktopScroll(args.direction as string, args.amount as number | undefined, args.x as number | undefined, args.y as number | undefined);
      case "desktop_drag":
        return this.handleDesktopDrag(args.fromX as number, args.fromY as number, args.toX as number, args.toY as number, args.button as string | undefined, args.duration as number | undefined);
      case "desktop_hover":
        return this.handleDesktopHover(args.x as number, args.y as number, args.coordMap as string | undefined);
      case "desktop_windows":
        return this.handleDesktopWindows();
      case "desktop_clipboard":
        return this.handleDesktopClipboard(args.action as string, args.text as string | undefined);
      case "desktop_processes":
        return this.handleDesktopProcesses(args.sort as string | undefined);
      case "desktop_quit_app":
        return this.handleDesktopQuitApp(args.name as string | undefined, args.pid as number | undefined, args.strategy as string | undefined);
      case "desktop_suggest_quit":
        return this.handleDesktopSuggestQuit();
      case "desktop_safe_list":
        return this.handleDesktopSafeList(args.action as string, args.app as string | undefined);

      // Browser Harness tools (CDP-first)
      case "browser_open":
        return this.handleBrowserOpen(
          args.url as string,
          args.headless as boolean | undefined,
          args.remote_ws_url as string | undefined
        );
      case "browser_state":
        return this.handleBrowserState();
      case "browser_click":
        return this.handleBrowserClick(
          args.selector as string | undefined,
          args.x as number | undefined,
          args.y as number | undefined
        );
      case "browser_type":
        return this.handleBrowserType(
          args.text as string,
          args.selector as string | undefined
        );
      case "browser_eval":
        return this.handleBrowserEval(args.expression as string);
      case "browser_screenshot":
        return this.handleBrowserScreenshot(
          args.path as string | undefined,
          args.format as string | undefined
        );
      case "browser_scroll":
        return this.handleBrowserScroll(
          args.direction as string | undefined,
          args.amount as number | undefined
        );
      case "browser_elements":
        return this.handleBrowserElements();
      case "browser_close":
        return this.handleBrowserClose();

      // Trading tools (Polymarket)
      case "trade_browse":
        return this.handleTradeBrowse(
          args.query as string | undefined,
          args.limit as number | undefined
        );
      case "trade_market":
        return this.handleTradeMarket(args.market_id as string);
      case "trade_opportunities":
        return this.handleTradeOpportunities(args.limit as number | undefined);
      case "trade_buy":
        return this.handleTradeBuy(
          args.market_id as string,
          args.outcome as string,
          args.size as number,
          args.price as number | undefined,
          args.confidence as number,
          args.reasoning as string
        );
      case "trade_sell":
        return this.handleTradeSell(
          args.market_id as string,
          args.outcome as string,
          args.size as number,
          args.price as number | undefined,
          args.reasoning as string | undefined
        );
      case "trade_positions":
        return this.handleTradePositions();
      case "trade_balance":
        return this.handleTradeBalance();
      case "trade_strategy":
        return this.handleTradeStrategy(args as Partial<Record<string, unknown>>);
      case "trade_journal":
        return this.handleTradeJournal(args.limit as number | undefined);

      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  // ============================================
  // Code Exploration
  // ============================================

  private async getOutline(filePath: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDirectory, filePath);

    if (!fs.existsSync(absolutePath)) {
      return `File not found: ${absolutePath}`;
    }

    try {
      const outline = parseTypeScriptFile(absolutePath);
      const symbols = outline.symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        lines: `${s.startLine}-${s.endLine}`,
        signature: s.signature?.slice(0, 80),
      }));

      return JSON.stringify({
        filePath: absolutePath,
        language: outline.language,
        symbolCount: symbols.length,
        symbols,
      }, null, 2);
    } catch (err) {
      return `Error parsing file: ${err}`;
    }
  }

  private async getSymbol(symbolId: string): Promise<string> {
    const separatorIndex = symbolId.lastIndexOf("::");
    if (separatorIndex === -1) {
      return `Invalid symbol ID format. Expected 'path/to/file.ts::symbolName'`;
    }

    const filePath = symbolId.slice(0, separatorIndex);
    const symbolName = symbolId.slice(separatorIndex + 2);

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDirectory, filePath);

    if (!fs.existsSync(absolutePath)) {
      return `File not found: ${absolutePath}`;
    }

    try {
      const outline = parseTypeScriptFile(absolutePath);
      const symbol = outline.symbols.find(s => s.name === symbolName);

      if (!symbol) {
        return `Symbol '${symbolName}' not found. Available: ${outline.symbols.map(s => s.name).join(", ")}`;
      }

      const source = getSymbolSource(absolutePath, symbol.startLine, symbol.endLine);
      return `// ${symbol.kind}: ${symbol.name}\n// Lines ${symbol.startLine}-${symbol.endLine}\n\n${source}`;
    } catch (err) {
      return `Error: ${err}`;
    }
  }

  private async searchSymbols(query: string, kinds?: string[]): Promise<string> {
    const { glob } = await import("glob");

    const files = await glob("**/*.{ts,tsx,js,jsx}", {
      cwd: this.workingDirectory,
      absolute: true,
      ignore: ["**/node_modules/**", "**/dist/**"],
    });

    const queryLower = query.toLowerCase();
    const matches: { name: string; kind: string; file: string; line: number }[] = [];

    for (const file of files.slice(0, 50)) {
      try {
        const outline = parseTypeScriptFile(file);
        for (const symbol of outline.symbols) {
          if (kinds && !kinds.includes(symbol.kind)) continue;
          if (symbol.name.toLowerCase().includes(queryLower)) {
            matches.push({
              name: symbol.name,
              kind: symbol.kind,
              file: path.relative(this.workingDirectory, file),
              line: symbol.startLine,
            });
          }
          if (matches.length >= 20) break;
        }
      } catch {
        // Skip unparseable files
      }
      if (matches.length >= 20) break;
    }

    return JSON.stringify({ query, matches }, null, 2);
  }

  private async getProjectOutline(): Promise<string> {
    // Ensure index is ready
    if (!this.astIndexReady && this.astIndexPromise) {
      try {
        await this.astIndexPromise;
      } catch {
        return "AST index not available. Use get_outline on individual files instead.";
      }
    }

    if (!this.astRepoId) {
      return "Project not indexed. Use get_outline on individual files instead.";
    }

    const fileTree = astGetFileTree(this.astRepoId);
    if (fileTree.length === 0) {
      return "No indexed files found in project.";
    }

    const fileEntries: string[] = [];
    let totalSymbols = 0;

    for (const filePath of fileTree) {
      const outline = astGetFileOutline(this.astRepoId, filePath);
      if (outline) {
        const symbolNames = outline.symbols.map(s => `${s.kind[0]}:${s.name}`).join(", ");
        const count = outline.symbols.length;
        totalSymbols += count;
        fileEntries.push(`  ${filePath} (${count}) → ${symbolNames}`);
      }
    }

    return [
      `[PROJECT MAP] ${fileTree.length} files, ${totalSymbols} symbols indexed`,
      `Root: ${this.workingDirectory}`,
      "",
      "Files (symbol count) → symbols:",
      ...fileEntries,
      "",
      "TIP: Use get_symbol('path/to/file.ts::symbolName') to fetch specific code.",
    ].join("\n");
  }

  // ============================================
  // File Operations
  // ============================================

  private async readFile(filePath: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDirectory, filePath);

    if (!fs.existsSync(absolutePath)) {
      return `File not found: ${absolutePath}`;
    }

    const content = fs.readFileSync(absolutePath, "utf-8");
    const lines = content.split("\n");

    // AST-first interception: for code files > 200 lines, prepend outline
    const isCodeFile = /\.(ts|tsx|js|jsx)$/.test(absolutePath);
    if (isCodeFile && lines.length > 200) {
      let outlineHeader = "";

      // Ensure index is ready (wait briefly if still indexing)
      if (!this.astIndexReady && this.astIndexPromise) {
        try {
          await Promise.race([this.astIndexPromise, new Promise((_, reject) => setTimeout(() => reject("timeout"), 500))]);
        } catch {
          // Index not ready yet, proceed without outline
        }
      }

      if (this.astIndexReady && this.astRepoId) {
        const relativePath = path.relative(this.workingDirectory, absolutePath);
        const outline = astGetFileOutline(this.astRepoId, relativePath);
        if (outline && outline.symbols.length > 0) {
          const symbolList = outline.symbols
            .map(s => `  ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`)
            .join("\n");
          outlineHeader = `[AST: This file has ${outline.symbols.length} symbols. Use get_symbol to fetch specific ones instead of reading the full file.]\n\nSymbols:\n${symbolList}\n\n---\n\n`;
        }
      } else {
        // Fallback: parse directly if index isn't ready
        try {
          const directOutline = parseTypeScriptFile(absolutePath);
          if (directOutline.symbols.length > 0) {
            const symbolList = directOutline.symbols
              .map(s => `  ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`)
              .join("\n");
            outlineHeader = `[AST: This file has ${directOutline.symbols.length} symbols. Use get_symbol to fetch specific ones instead of reading the full file.]\n\nSymbols:\n${symbolList}\n\n---\n\n`;
          }
        } catch {
          // Can't parse, just return truncated content
        }
      }

      return `${outlineHeader}// File has ${lines.length} lines. Showing first 200:\n\n${lines.slice(0, 200).join("\n")}\n\n// ... truncated. Use get_outline + get_symbol for specific sections.`;
    }

    return content;
  }

  private async writeFile(filePath: string, content: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDirectory, filePath);

    // Design-agent gate: if writing a UI file, enforce design quality
    const uiExtensions = [".tsx", ".jsx", ".css", ".html", ".svelte", ".vue"];
    const ext = path.extname(absolutePath).toLowerCase();
    let designHint = "";
    if (uiExtensions.includes(ext)) {
      try {
        // Check for DESIGN.md in project root - this is the quality gate
        const designMdPath = path.join(this.workingDirectory, "DESIGN.md");
        if (fs.existsSync(designMdPath)) {
          const designContent = fs.readFileSync(designMdPath, "utf-8");
          const { tokens } = parseDesignMd(designContent);
          if (tokens.name && tokens.name !== 'Untitled') {
            // Build color list for the hint
            const colorNames = tokens.colors ? Object.keys(tokens.colors).join(', ') : '';
            const typoNames = tokens.typography ? Object.keys(tokens.typography).join(', ') : '';

            designHint = `\n[Design Gate] Active DESIGN.md: "${tokens.name}". STRICT RULES:
1. Do NOT invent colors, fonts, or spacing. Every value must come from DESIGN.md tokens.
2. Colors registered: ${colorNames}
3. Typography scales: ${typoNames}

TAILWIND v4 TOKEN MAPPING (CRITICAL - get this wrong and nothing renders):
- Colors in @theme as --color-{name} become utility classes: bg-primary, text-on-primary, border-outline-variant, etc.
  Dashed names work: text-on-surface-variant, bg-surface-container, bg-secondary-container.
- Radius in @theme as --radius-{size} become: rounded-sm, rounded-lg, rounded-xl, rounded-2xl, rounded-full.
- Spacing: put in :root as --sp-{size}, use as px-[var(--sp-md)], py-[var(--sp-lg)], gap-[var(--sp-gutter)], mb-[var(--sp-xl)].
  DO NOT use px-[--sp-md] (missing var()). DO NOT use px-[--spacing-md] (wrong prefix).
- Typography: define as @layer utilities { .type-display { ... } } classes. Use directly: className="type-display".
- NEVER use arbitrary hex values like bg-[#6366F1]. Always use the token class: bg-primary.

Run lint_design_md after writing to validate.`;
          }
        }

        const isNewFile = !fs.existsSync(absolutePath);
        if (isNewFile && needsDesignDecision(`create UI file ${path.basename(absolutePath)}`)) {
          const detection = await detectDesignNeed(`create UI component: ${path.basename(absolutePath)}`);
          if (detection.needsDesign) {
            designHint += `\n[Design Agent] This is a new UI file. Consider using suggest_design or query_design_system to ensure consistent design. Detected: ${detection.reason}`;
          }
        }
      } catch {
        // Design check is advisory, never block writes
      }
    }

    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(absolutePath, content);

    // Auto-open files on macOS for immediate viewing
    if (process.platform === "darwin") {
      try {
        const { spawn } = await import("child_process");
        spawn("open", [absolutePath], { detached: true, stdio: "ignore" }).unref();
      } catch {}
    }

    return `File written and opened: ${absolutePath}${designHint}`;
  }

  private async editFile(filePath: string, oldText: string, newText: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDirectory, filePath);

    if (!fs.existsSync(absolutePath)) {
      return `File not found: ${absolutePath}`;
    }

    const content = fs.readFileSync(absolutePath, "utf-8");

    if (!content.includes(oldText)) {
      return `Error: Could not find the text to replace in ${filePath}. Make sure oldText matches exactly.`;
    }

    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(absolutePath, newContent);

    return `File edited: ${absolutePath}\nReplaced ${oldText.length} chars with ${newText.length} chars.`;
  }

  private async listFiles(dirPath: string = ".", pattern?: string): Promise<string> {
    const { glob } = await import("glob");

    const absolutePath = path.isAbsolute(dirPath)
      ? dirPath
      : path.join(this.workingDirectory, dirPath);

    const files = await glob(pattern || "**/*", {
      cwd: absolutePath,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      nodir: true,
    });

    return files.slice(0, 100).join("\n");
  }

  // ============================================
  // Shell Command Execution
  // ============================================

  async runCommand(command: string): Promise<string> {
    const { spawn } = await import("child_process");

    const permissionCheck = this.permissionManager.checkPermission(command);

    if (permissionCheck === "denied") {
      return `[PERMISSION DENIED] Command blocked by security policy: ${command}`;
    }

    if (permissionCheck === "ask") {
      const allowed = await this.permissionManager.requestPermission(
        "Execute Shell Command",
        isCommandDangerous(command)
          ? "This command may modify system files or cause data loss."
          : "The agent wants to run a shell command.",
        command
      );

      if (!allowed) {
        return `[PERMISSION DENIED] User declined to execute: ${command}`;
      }
    }

    // Validate command for shell injection before execution
    const validation = sanitizeShellCommand(command);
    if (!validation.safe) {
      return `[BLOCKED] ${validation.reason}. Command: ${command}`;
    }

    const startTime = Date.now();
    await this.hookManager.executeHooks("beforeCommand", {
      command,
      workingDirectory: this.workingDirectory,
    });

    let finalCommand = command;
    if (command.includes('create-next-app') && !command.includes('--yes')) {
      finalCommand = command.replace('create-next-app', 'create-next-app --yes');
    }
    if (command.includes('npm init') && !command.includes('-y')) {
      finalCommand = command + ' -y';
    }

    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', finalCommand], {
        cwd: this.workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      // SECURITY: Removed stdin auto-answer hack (was sending \n every 1s,
      // could silently confirm destructive interactive prompts)

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');

        this.hookManager.executeHooks("afterCommand", {
          command: finalCommand,
          exitCode: -1,
          stdout,
          stderr: stderr + "\nTIMEOUT",
          duration: Date.now() - startTime,
          workingDirectory: this.workingDirectory,
        });

        resolve(`TIMEOUT after 2 min. Partial output:\n${stdout}\n${stderr}\nTIP: Try bun instead of npx, or add --yes flag.`);
      }, 120000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        // stdinInterval removed (security fix)

        this.hookManager.executeHooks("afterCommand", {
          command: finalCommand,
          exitCode: code ?? 0,
          stdout,
          stderr,
          duration: Date.now() - startTime,
          workingDirectory: this.workingDirectory,
        });

        if (code === 0) {
          resolve(stdout || stderr || "Command completed successfully.");
        } else {
          resolve(`Exit code ${code}:\n${stdout}\n${stderr}`);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        // stdinInterval removed (security fix)

        this.hookManager.executeHooks("onError", {
          command: finalCommand,
          error: err.message,
          workingDirectory: this.workingDirectory,
        });

        resolve(`Error: ${err.message}`);
      });
    });
  }

  /**
   * Run a command with explicit argument array (no shell interpolation).
   * Use for commands with LLM-provided arguments to prevent injection.
   */
  private async runSpawn(cmd: string, args: string[]): Promise<string> {
    const { spawn } = await import("child_process");
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const proc = spawn(cmd, args, { cwd: this.workingDirectory });
      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code: number | null) => {
        resolve(code === 0 ? stdout.trim() : `Error (exit ${code}): ${stderr.trim()}`);
      });
      proc.on("error", (err: Error) => resolve(`Error: ${err.message}`));
    });
  }

  // ============================================
  // Image Tool Handlers
  // ============================================

  private async handleReadImage(imagePath: string): Promise<string> {
    const absolutePath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(this.workingDirectory, imagePath);

    try {
      const imageInfo = await readImage(absolutePath);
      return JSON.stringify({
        path: imageInfo.path,
        width: imageInfo.width,
        height: imageInfo.height,
        format: imageInfo.format,
        size: imageInfo.size,
        channels: imageInfo.channels,
        hasAlpha: imageInfo.hasAlpha,
        base64Length: imageInfo.base64.length,
        base64Preview: imageInfo.base64.slice(0, 100) + "...",
      }, null, 2);
    } catch (err) {
      return `Error reading image: ${err}`;
    }
  }

  private async handleDescribeImage(imagePath: string, prompt?: string): Promise<string> {
    const absolutePath = path.isAbsolute(imagePath)
      ? imagePath
      : path.join(this.workingDirectory, imagePath);

    try {
      const description = await describeImage(
        absolutePath,
        prompt || "Describe this image in detail.",
        "llava"
      );
      return JSON.stringify({
        path: description.path,
        description: description.description,
        width: description.width,
        height: description.height,
        format: description.format,
        model: description.model,
      }, null, 2);
    } catch (err) {
      return `Error describing image: ${err}`;
    }
  }

  // ============================================
  // PDF Tool Handlers
  // ============================================

  private async handleReadPdf(pdfPath: string): Promise<string> {
    const absolutePath = path.isAbsolute(pdfPath)
      ? pdfPath
      : path.join(this.workingDirectory, pdfPath);

    try {
      const pdfInfo = await readPdf(absolutePath);
      const maxTextLength = 10000;
      const truncatedText = pdfInfo.text.length > maxTextLength
        ? pdfInfo.text.slice(0, maxTextLength) + `\n\n... [truncated, ${pdfInfo.text.length - maxTextLength} more chars]`
        : pdfInfo.text;

      return JSON.stringify({
        path: pdfInfo.path,
        pageCount: pdfInfo.pageCount,
        metadata: pdfInfo.metadata,
        textLength: pdfInfo.text.length,
        text: truncatedText,
      }, null, 2);
    } catch (err) {
      return `Error reading PDF: ${err}`;
    }
  }

  private async handleReadPdfPage(pdfPath: string, pageNum: number): Promise<string> {
    const absolutePath = path.isAbsolute(pdfPath)
      ? pdfPath
      : path.join(this.workingDirectory, pdfPath);

    try {
      const pageContent = await readPdfPage(absolutePath, pageNum);
      return JSON.stringify({
        path: pageContent.path,
        pageNumber: pageContent.pageNumber,
        totalPages: pageContent.totalPages,
        text: pageContent.text,
      }, null, 2);
    } catch (err) {
      return `Error reading PDF page: ${err}`;
    }
  }

  // ============================================
  // Notebook Tool Handlers
  // ============================================

  private async handleReadNotebook(notebookPath: string): Promise<string> {
    const absolutePath = path.isAbsolute(notebookPath)
      ? notebookPath
      : path.join(this.workingDirectory, notebookPath);

    try {
      const notebook = await readNotebook(absolutePath);
      const formattedCells = notebook.cells.map(cell => ({
        index: cell.index,
        type: cell.type,
        executionCount: cell.executionCount,
        source: cell.source.length > 500
          ? cell.source.slice(0, 500) + "... [truncated]"
          : cell.source,
        outputCount: cell.outputs.length,
        outputs: cell.outputs.slice(0, 3).map(o => ({
          type: o.type,
          text: o.text?.slice(0, 200),
          hasError: !!o.error,
        })),
      }));

      return JSON.stringify({
        path: notebook.path,
        kernel: notebook.kernel,
        language: notebook.language,
        cellCount: notebook.cellCount,
        cells: formattedCells,
      }, null, 2);
    } catch (err) {
      return `Error reading notebook: ${err}`;
    }
  }

  private async handleNotebookEditCell(
    notebookPath: string,
    cellIndex: number,
    newSource: string
  ): Promise<string> {
    const absolutePath = path.isAbsolute(notebookPath)
      ? notebookPath
      : path.join(this.workingDirectory, notebookPath);

    try {
      const result = await editCell(absolutePath, cellIndex, newSource);
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error editing notebook cell: ${err}`;
    }
  }

  private async handleNotebookInsertCell(
    notebookPath: string,
    afterIndex: number,
    cellType: "code" | "markdown",
    source: string
  ): Promise<string> {
    const absolutePath = path.isAbsolute(notebookPath)
      ? notebookPath
      : path.join(this.workingDirectory, notebookPath);

    try {
      const result = await insertCell(absolutePath, afterIndex, cellType, source);
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error inserting notebook cell: ${err}`;
    }
  }

  private async handleNotebookDeleteCell(
    notebookPath: string,
    cellIndex: number
  ): Promise<string> {
    const absolutePath = path.isAbsolute(notebookPath)
      ? notebookPath
      : path.join(this.workingDirectory, notebookPath);

    try {
      const result = await deleteCell(absolutePath, cellIndex);
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error deleting notebook cell: ${err}`;
    }
  }

  // ============================================
  // Multi-Agent Orchestration
  // ============================================

  private async handleSpawnAgent(
    task: string,
    runtime?: "8gent" | "claude" | "shell",
    model?: string,
    timeout?: number
  ): Promise<string> {
    try {
      const effectiveRuntime = runtime || "8gent";

      // CLI runtimes: claude and shell
      if (effectiveRuntime === "claude" || effectiveRuntime === "shell") {
        const { spawnCLIAgent } = await import("../orchestration");
        const agent = spawnCLIAgent(effectiveRuntime, task, {
          workingDirectory: this.workingDirectory,
          timeout: timeout || undefined,
        });
        return JSON.stringify({
          agentId: agent.id,
          runtime: effectiveRuntime,
          status: "running",
          task: task.slice(0, 100),
          message: `CLI agent ${agent.id} (${effectiveRuntime}) spawned and running. Use check_agent("${agent.id}") to check status.`,
        }, null, 2);
      }

      // Default: 8gent runtime
      // Resolve "auto:free" to the best available free model via OpenRouter
      let resolvedModel = model;
      if (model === "auto:free") {
        try {
          const { resolveModel } = await import("../providers");
          const resolved = await resolveModel(model);
          resolvedModel = resolved.model;
        } catch {
          // Fall back to default if provider resolution fails
          resolvedModel = undefined;
        }
      }
      const { getAgentPool } = await import("../orchestration");
      const pool = getAgentPool();
      const agent = await pool.spawnAgent(task, {
        model: resolvedModel || undefined,
        workingDirectory: this.workingDirectory,
      });
      return JSON.stringify({
        agentId: agent.id,
        runtime: "8gent",
        status: agent.status,
        task: task.slice(0, 100),
        message: `Agent ${agent.id} spawned and running. Use check_agent("${agent.id}") to check status.`,
      }, null, 2);
    } catch (err) {
      return `Failed to spawn agent: ${err}`;
    }
  }

  private async handleCheckAgent(agentId: string): Promise<string> {
    try {
      // Check CLI agents first (claude/shell runtimes)
      if (agentId.startsWith("cli-")) {
        const { getCLIAgentStatus } = await import("../orchestration");
        const status = getCLIAgentStatus(agentId);
        if (!status) return `Agent not found: ${agentId}`;

        const result: Record<string, unknown> = {
          agentId: status.id,
          runtime: status.runtime,
          status: status.status,
          task: status.task,
          elapsed: status.elapsed,
        };

        if (status.result) {
          result.stdout = status.result.stdout.slice(0, 2000);
          if (status.result.stderr) {
            result.stderr = status.result.stderr.slice(0, 500);
          }
          result.exitCode = status.result.exitCode;
        }

        return JSON.stringify(result, null, 2);
      }

      // Default: check 8gent agent pool
      const { getAgentPool } = await import("../orchestration");
      const pool = getAgentPool();
      const agent = pool.getAgent(agentId);
      if (!agent) return `Agent not found: ${agentId}`;

      const elapsed = agent.completedAt
        ? `${((agent.completedAt.getTime() - agent.startedAt.getTime()) / 1000).toFixed(1)}s`
        : `${((Date.now() - agent.startedAt.getTime()) / 1000).toFixed(1)}s (running)`;

      const result: Record<string, unknown> = {
        agentId: agent.id,
        runtime: "8gent",
        status: agent.status,
        task: agent.task.description,
        elapsed,
      };

      if (agent.status === "completed" && agent.task.result) {
        result.result = typeof agent.task.result === "string"
          ? agent.task.result.slice(0, 2000)
          : JSON.stringify(agent.task.result).slice(0, 2000);
      }
      if (agent.status === "failed" && agent.task.error) {
        result.error = agent.task.error;
      }

      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Failed to check agent: ${err}`;
    }
  }

  private async handleListAgents(): Promise<string> {
    try {
      const { getAgentPool, listCLIAgents, getCLIAgentStatus } = await import("../orchestration");
      const pool = getAgentPool();
      const poolAgents = pool.listAgents();
      const cliAgentsList = listCLIAgents();

      if (poolAgents.length === 0 && cliAgentsList.length === 0) {
        return "No agents spawned yet. Use spawn_agent to create background agents for parallel tasks.";
      }

      const stats = pool.getStats();

      // 8gent agents
      const eightAgentList = poolAgents.map((a) => {
        const elapsed = a.completedAt
          ? `${((a.completedAt.getTime() - a.startedAt.getTime()) / 1000).toFixed(1)}s`
          : `${((Date.now() - a.startedAt.getTime()) / 1000).toFixed(1)}s`;
        return {
          id: a.id,
          runtime: "8gent" as const,
          status: a.status,
          task: a.task.description.slice(0, 80),
          elapsed,
          hasResult: a.status === "completed" && !!a.task.result,
        };
      });

      // CLI agents (claude/shell)
      const cliAgentList = cliAgentsList.map((a) => {
        const status = getCLIAgentStatus(a.id);
        return {
          id: a.id,
          runtime: a.runtime,
          status: status?.status || "running",
          task: a.task.slice(0, 80),
          elapsed: status?.elapsed || "...",
          hasResult: !!a.result,
        };
      });

      const allAgents = [...eightAgentList, ...cliAgentList];

      // Augment stats with CLI agents
      const cliRunning = cliAgentsList.filter(a => !a.completedAt).length;
      const cliCompleted = cliAgentsList.filter(a => a.completedAt && a.result?.exitCode === 0).length;
      const cliFailed = cliAgentsList.filter(a => a.completedAt && a.result?.exitCode !== 0).length;

      return JSON.stringify({
        stats: {
          ...stats,
          totalAgents: stats.totalAgents + cliAgentsList.length,
          running: stats.running + cliRunning,
          completed: stats.completed + cliCompleted,
          failed: stats.failed + cliFailed,
        },
        agents: allAgents,
      }, null, 2);
    } catch (err) {
      return `Failed to list agents: ${err}`;
    }
  }

  // ============================================
  // Web Tools
  // ============================================

  private async handleWebSearch(query: string, maxResults?: number): Promise<string> {
    try {
      const results = await webSearch(query, { maxResults: maxResults || 10 });
      return formatSearchResults(results);
    } catch (err) {
      return `Web search failed: ${err}`;
    }
  }

  private async handleWebFetch(url: string): Promise<string> {
    try {
      const result = await webFetch(url);
      return formatFetchResult(result);
    } catch (err) {
      return `Web fetch failed: ${err}`;
    }
  }

  // ============================================
  // MCP Tools
  // ============================================

  private async handleMCPListTools(): Promise<string> {
    try {
      const mcpClient = getMCPClient();
      const tools = mcpClient.listTools();

      if (tools.length === 0) {
        return "No MCP tools available. Configure servers in ~/.8gent/mcp.json";
      }

      const grouped: Record<string, string[]> = {};
      for (const { server, tool } of tools) {
        if (!grouped[server]) grouped[server] = [];
        grouped[server].push(`  - ${tool.name}: ${tool.description || "No description"}`);
      }

      let output = "Available MCP Tools:\n\n";
      for (const [server, toolList] of Object.entries(grouped)) {
        output += `**${server}**\n${toolList.join("\n")}\n\n`;
      }

      return output;
    } catch (err) {
      return `MCP list tools failed: ${err}`;
    }
  }

  private async handleMCPCallTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>
  ): Promise<string> {
    try {
      const mcpClient = getMCPClient();
      const result = await mcpClient.callTool(serverName, toolName, args);
      return formatToolResult(result);
    } catch (err) {
      return `MCP call tool failed: ${err}`;
    }
  }

  // ============================================
  // Background Task Tools
  // ============================================

  private async handleBackgroundStart(command: string, timeout?: number): Promise<string> {
    try {
      const taskManager = getBackgroundTaskManager(this.workingDirectory);
      const taskId = taskManager.startTask(command, { timeout });
      return `Background task started: ${taskId}\nCommand: ${command}\nUse background_status or background_output to check progress.`;
    } catch (err) {
      return `Failed to start background task: ${err}`;
    }
  }

  private async handleBackgroundStatus(taskId: string): Promise<string> {
    try {
      const taskManager = getBackgroundTaskManager();
      const status = taskManager.getTaskStatus(taskId);

      if (!status) {
        return `Task not found: ${taskId}`;
      }

      return formatTaskStatus(status);
    } catch (err) {
      return `Failed to get task status: ${err}`;
    }
  }

  private async handleBackgroundOutput(taskId: string, tail?: number): Promise<string> {
    try {
      const taskManager = getBackgroundTaskManager();
      const status = taskManager.getTaskStatus(taskId);
      const output = taskManager.getTaskOutput(taskId, { tail });

      if (!status || !output) {
        return `Task not found: ${taskId}`;
      }

      return formatTaskOutput(output, status);
    } catch (err) {
      return `Failed to get task output: ${err}`;
    }
  }

  // ============================================
  // Design Tools
  // ============================================

  private async handleSuggestDesign(task: string, projectType?: string): Promise<string> {
    try {
      // Step 1: Detect design needs from the task description
      const detection = await detectDesignNeed(task);

      if (!detection.needsDesign) {
        return JSON.stringify({
          needsDesign: false,
          reason: detection.reason,
          message: "This task doesn't appear to require design decisions.",
        }, null, 2);
      }

      // Step 2: Get design system suggestions from the design-agent
      const suggestions = await suggestDesignSystems(detection);

      // Step 3: If a project type is provided, also query the design-systems DB
      let dbSuggestions: any[] = [];
      if (projectType) {
        try {
          initDesignDb();
          dbSuggestions = suggestDesignForProject(projectType, { maxResults: 3 }).map(s => ({
            name: s.system.system.name,
            style: s.system.system.style,
            mood: s.system.system.mood,
            score: s.score,
            reasoning: s.reasoning,
            colors: s.system.parsedColors ? {
              primary: s.system.parsedColors.primary,
              background: s.system.parsedColors.background,
              accent: s.system.parsedColors.accent,
            } : null,
            tags: s.system.tags,
          }));
        } catch {
          // DB not seeded yet, skip
        }
      }

      return JSON.stringify({
        needsDesign: true,
        confidence: detection.confidence,
        projectType: detection.projectType,
        categories: detection.suggestedCategories,
        frameworkSuggestions: suggestions.suggestions.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          reasoning: s.reasoning,
          score: s.score,
          stack: s.stack,
          installCommands: s.installCommands,
          setupSteps: s.setupSteps,
        })),
        designSystemSuggestions: dbSuggestions,
        availableSystems: getAvailableDesignSystems().map(s => s.name),
      }, null, 2);
    } catch (err) {
      return `Design suggestion failed: ${err}`;
    }
  }

  private async handleQueryDesignSystem(args: Record<string, unknown>): Promise<string> {
    try {
      initDesignDb();

      const query = args.query as string | undefined;
      const style = args.style as string | undefined;
      const mood = args.mood as string | undefined;
      const output = (args.output as string) || "summary";

      // If a specific query, search for it
      if (query) {
        // Try to get a complete design system by name first
        const complete = getCompleteDesignSystem(query);
        if (complete) {
          if (output === "css") {
            const css = generateCssVariables(complete.system.id);
            return css || "No color palette available for CSS generation.";
          }
          if (output === "tailwind") {
            const config = generateTailwindConfig(complete.system.id);
            return config ? JSON.stringify(config, null, 2) : "No color palette available for Tailwind config.";
          }
          if (output === "hex") {
            const hex = getHexPalette(complete.system.id);
            return hex ? JSON.stringify(hex, null, 2) : "No color palette available.";
          }
          // Default: full summary
          return JSON.stringify({
            name: complete.system.name,
            style: complete.system.style,
            mood: complete.system.mood,
            description: complete.system.description,
            colors: complete.parsedColors,
            typography: complete.parsedTypography,
            components: complete.components.map(c => ({ type: c.type, name: c.name, description: c.description })),
            tags: complete.tags,
          }, null, 2);
        }

        // Fall back to text search
        const results = searchDesignSystems_db(query);
        return JSON.stringify({
          query,
          results: results.map(s => ({
            id: s.id,
            name: s.name,
            style: s.style,
            mood: s.mood,
            description: s.description,
          })),
        }, null, 2);
      }

      // Filter by style
      if (style) {
        const results = findDesignByStyle(style as any);
        return JSON.stringify({
          style,
          results: results.map(s => ({ id: s.id, name: s.name, mood: s.mood, description: s.description })),
        }, null, 2);
      }

      // Filter by mood
      if (mood) {
        const results = findDesignByMood(mood as any);
        return JSON.stringify({
          mood,
          results: results.map(s => ({ id: s.id, name: s.name, style: s.style, description: s.description })),
        }, null, 2);
      }

      // No filters — list all with available styles/moods
      const all = listAllDesignSystems();
      return JSON.stringify({
        totalSystems: all.length,
        availableStyles: listDesignStyles(),
        availableMoods: listDesignMoods(),
        systems: all.map(s => ({ id: s.id, name: s.name, style: s.style, mood: s.mood })),
      }, null, 2);
    } catch (err) {
      return `Design system query failed: ${err}`;
    }
  }

  // ============================================
  // DESIGN.md Format Tools (Quality Gate)
  // ============================================

  private async handleLintDesignMd(content?: string, filePath?: string): Promise<string> {
    try {
      let mdContent = content;
      if (!mdContent && filePath) {
        const fs = await import('fs');
        mdContent = fs.readFileSync(filePath, 'utf-8');
      }
      if (!mdContent) {
        return JSON.stringify({ error: 'Provide either content or filePath' });
      }

      const report = lintDesignMd(mdContent);
      return JSON.stringify({
        valid: report.valid,
        summary: report.summary,
        findings: report.findings,
        name: report.tokens?.name,
        hasColors: !!report.tokens?.colors,
        hasTypography: !!report.tokens?.typography,
        hasComponents: !!report.tokens?.components,
        colorCount: report.tokens?.colors ? Object.keys(report.tokens.colors).length : 0,
        typographyCount: report.tokens?.typography ? Object.keys(report.tokens.typography).length : 0,
        componentCount: report.tokens?.components ? Object.keys(report.tokens.components).length : 0,
      }, null, 2);
    } catch (err) {
      return `DESIGN.md lint failed: ${err}`;
    }
  }

  private async handleImportDesignMd(args: Record<string, unknown>): Promise<string> {
    try {
      let mdContent = args.content as string | undefined;
      if (!mdContent && args.filePath) {
        const fs = await import('fs');
        mdContent = fs.readFileSync(args.filePath as string, 'utf-8');
      }
      if (!mdContent) {
        return JSON.stringify({ error: 'Provide either content or filePath' });
      }

      const result = importDesignMd(mdContent, {
        style: args.style as any,
        mood: args.mood as any,
        tags: args.tags as string[] | undefined,
      });

      return JSON.stringify({
        imported: true,
        id: result.id,
        name: result.name,
        findingsCount: result.findings.length,
        findings: result.findings.slice(0, 10),
        message: `Design system "${result.name}" imported as "${result.id}". Query it with query_design_system.`,
      }, null, 2);
    } catch (err) {
      return `DESIGN.md import failed: ${err}`;
    }
  }

  private async handleExportDesignMd(name: string, asSpec?: boolean): Promise<string> {
    try {
      if (asSpec) {
        const spec = generateDesignSpec(name);
        return spec || `Design system "${name}" not found in database.`;
      }

      const md = exportDesignMd(name);
      return md || `Design system "${name}" not found in database.`;
    } catch (err) {
      return `DESIGN.md export failed: ${err}`;
    }
  }

  private async handleGenerateDesignMd(args: Record<string, unknown>): Promise<string> {
    try {
      const name = args.name as string;
      if (!name) return JSON.stringify({ error: 'name is required' });

      const md = generateDesignMd(name, {
        projectType: args.projectType as string | undefined,
        mood: args.mood as string | undefined,
        description: args.description as string | undefined,
        darkMode: args.darkMode as boolean | undefined,
      });

      // Lint the generated output to verify quality
      const { parseDesignMd: parse, lintDesignMd: lint } = await import("../design-systems/design-md.js");
      const parsed = parse(md);
      const report = lint(md);

      return JSON.stringify({
        designMd: md,
        tokenCount: {
          colors: parsed.tokens.colors ? Object.keys(parsed.tokens.colors).length : 0,
          typography: parsed.tokens.typography ? Object.keys(parsed.tokens.typography).length : 0,
          components: parsed.tokens.components ? Object.keys(parsed.tokens.components).length : 0,
        },
        lintResult: {
          valid: report.valid,
          errorCount: report.summary.errors,
          warningCount: report.summary.warnings,
          findings: report.findings.filter((f: { severity: string }) => f.severity === 'error'),
        },
        instructions: `Save this as DESIGN.md in the project root. The design gate will auto-enforce these tokens on all UI file writes.`,
      }, null, 2);
    } catch (err) {
      return `DESIGN.md generation failed: ${err}`;
    }
  }

  // ============================================
  // Infinite Mode
  // ============================================

  private async handleEnableInfiniteMode(
    task: string,
    maxIterations?: number,
    maxTimeMs?: number
  ): Promise<string> {
    try {
      const runner = createInfiniteRunner(task, {
        maxIterations: maxIterations ?? 100,
        maxTimeMs: maxTimeMs ?? 30 * 60 * 1000,
        workingDirectory: this.workingDirectory,
        onIteration: (state) => {
          console.log(`[infinite] ${formatInfiniteState(state)}`);
        },
        onErrorRecovered: (error, state) => {
          console.log(`[infinite] Recovered from: ${error.message.slice(0, 80)}`);
        },
      });

      // Run in background — don't block the tool call
      runner.run().then((finalState) => {
        console.log(`[infinite] Completed: ${finalState.phase} after ${finalState.iteration} iterations`);
      }).catch((err) => {
        console.log(`[infinite] Fatal error: ${err}`);
      });

      return `Infinite mode ENABLED for task: "${task}"\n` +
        `Max iterations: ${maxIterations ?? 100}\n` +
        `Max time: ${((maxTimeMs ?? 30 * 60 * 1000) / 1000 / 60).toFixed(0)} minutes\n` +
        `The agent will now loop autonomously until the task is complete or limits are reached.`;
    } catch (err) {
      return `Failed to enable infinite mode: ${err}`;
    }
  }

  // ============================================
  // Memory Tools
  // ============================================

  private async handleRemember(fact: string, layer: "session" | "project" | "global"): Promise<string> {
    try {
      const memory = getMemoryManager(this.workingDirectory);
      const id = memory.remember(fact, layer, { source: "user:remember" });
      const stats = memory.getStats();
      return `Remembered (${layer}): "${fact.slice(0, 80)}${fact.length > 80 ? "..." : ""}"\nID: ${id}\nMemory stats — session: ${stats.session}, project: ${stats.project}, global: ${stats.global}`;
    } catch (err) {
      return `Failed to remember: ${err}`;
    }
  }

  private async handleRecall(query: string, limit?: number): Promise<string> {
    try {
      const memory = getMemoryManager(this.workingDirectory);
      const results = memory.recall(query, limit ?? 10);

      if (results.length === 0) {
        return `No memories found matching "${query}".`;
      }

      const lines = results.map((r, i) => {
        const age = timeSince(new Date(r.entry.createdAt));
        return `${i + 1}. [${r.entry.layer}] (score: ${r.score.toFixed(2)}, ${age} ago) ${r.entry.fact}`;
      });

      return `Found ${results.length} memor${results.length === 1 ? "y" : "ies"} matching "${query}":\n${lines.join("\n")}`;
    } catch (err) {
      return `Failed to recall: ${err}`;
    }
  }

  // ============================================
  // Desktop Computer Use Tools (Power #10)
  // ============================================

  private async handleDesktopScreenshot(savePath?: string, displayId?: number): Promise<string> {
    try {
      const result = computerScreenshot({ path: savePath, displayId });
      if (!result.ok) return `desktop_screenshot failed: ${result.error}`;
      return JSON.stringify({
        path: result.path,
        coordMap: `${result.coordMap.captureX},${result.coordMap.captureY},${result.coordMap.captureWidth},${result.coordMap.captureHeight},${result.coordMap.imageWidth},${result.coordMap.imageHeight}`,
        hint: "Use the coordMap value with desktop_click/desktop_hover to translate image coordinates to screen coordinates.",
      });
    } catch (err) {
      return `desktop_screenshot failed: ${err}`;
    }
  }

  private async handleDesktopClick(x: number, y: number, button?: string, count?: number, coordMap?: string): Promise<string> {
    try {
      let point = { x, y };
      if (coordMap) {
        point = imageToDesktop(point, decodeCoordMap(coordMap));
      }
      const result = computerClick({
        point,
        button: (button as "left" | "right" | "middle") || "left",
        count,
      });
      if (!result.ok) return `desktop_click failed: ${result.error}`;
      return `Clicked at (${point.x}, ${point.y})${button ? ` with ${button} button` : ""}${count && count > 1 ? ` x${count}` : ""}`;
    } catch (err) {
      return `desktop_click failed: ${err}`;
    }
  }

  private async handleDesktopType(text: string, delay?: number): Promise<string> {
    try {
      const result = computerType({ text, delay });
      if (!result.ok) return `desktop_type failed: ${result.error}`;
      return `Typed ${text.length} characters`;
    } catch (err) {
      return `desktop_type failed: ${err}`;
    }
  }

  private async handleDesktopPress(keys: string, count?: number, delay?: number): Promise<string> {
    try {
      const result = computerPress({ keys, count, delay });
      if (!result.ok) return `desktop_press failed: ${result.error}`;
      const warning = result.error ? ` (${result.error})` : "";
      return `Pressed ${keys}${count && count > 1 ? ` x${count}` : ""}${warning}`;
    } catch (err) {
      return `desktop_press failed: ${err}`;
    }
  }

  private async handleDesktopScroll(direction: string, amount?: number, x?: number, y?: number): Promise<string> {
    try {
      const result = computerScroll({
        direction: direction as "up" | "down" | "left" | "right",
        amount,
        point: (x !== undefined && y !== undefined) ? { x, y } : undefined,
      });
      if (!result.ok) return `desktop_scroll failed: ${result.error}`;
      return `Scrolled ${direction}${amount ? ` x${amount}` : ""}`;
    } catch (err) {
      return `desktop_scroll failed: ${err}`;
    }
  }

  private async handleDesktopDrag(fromX: number, fromY: number, toX: number, toY: number, button?: string, duration?: number): Promise<string> {
    try {
      const result = computerDrag({
        from: { x: fromX, y: fromY },
        to: { x: toX, y: toY },
        button: (button as "left" | "right" | "middle") || "left",
        duration,
      });
      if (!result.ok) return `desktop_drag failed: ${result.error}`;
      return `Dragged from (${fromX}, ${fromY}) to (${toX}, ${toY})`;
    } catch (err) {
      return `desktop_drag failed: ${err}`;
    }
  }

  private async handleDesktopHover(x: number, y: number, coordMap?: string): Promise<string> {
    try {
      let point = { x, y };
      if (coordMap) {
        point = imageToDesktop(point, decodeCoordMap(coordMap));
      }
      const result = computerHover(point);
      if (!result.ok) return `desktop_hover failed: ${result.error}`;
      return `Moved cursor to (${point.x}, ${point.y})`;
    } catch (err) {
      return `desktop_hover failed: ${err}`;
    }
  }

  private async handleDesktopWindows(): Promise<string> {
    try {
      const result = computerWindowList();
      if (!result.ok) return `desktop_windows failed: ${result.error}`;
      if (!result.windows || result.windows.length === 0) return "No windows found";
      const lines = result.windows.map((w, i) =>
        `${i + 1}. [${w.app}] "${w.title}" at (${w.x},${w.y}) ${w.width}x${w.height}`
      );
      return `Open windows (${result.windows.length}):\n${lines.join("\n")}`;
    } catch (err) {
      return `desktop_windows failed: ${err}`;
    }
  }

  private async handleDesktopClipboard(action: string, text?: string): Promise<string> {
    try {
      if (action === "set") {
        if (!text) return "desktop_clipboard set requires text parameter";
        const result = computerClipboardSet(text);
        if (!result.ok) return `desktop_clipboard failed: ${result.error}`;
        return `Clipboard set (${text.length} chars)`;
      } else {
        const result = computerClipboardGet();
        if (!result.ok) return `desktop_clipboard failed: ${result.error}`;
        return `Clipboard contents:\n${result.text || "(empty)"}`;
      }
    } catch (err) {
      return `desktop_clipboard failed: ${err}`;
    }
  }

  // ============================================
  // Process Management Tools
  // ============================================

  private async handleDesktopProcesses(sort?: string): Promise<string> {
    try {
      const processes = computerListProcesses((sort as "memory" | "cpu" | "name") || "memory");
      if (processes.length === 0) return "No processes found";
      const lines = processes.map((p, i) =>
        `${String(i + 1).padStart(2)}. ${p.name.padEnd(25)} ${String(p.memoryMB).padStart(6)} MB  ${String(p.cpu ?? 0).padStart(5)}% CPU  (PID ${p.pid})`
      );
      return `Running processes (top ${processes.length}, sorted by ${sort || "memory"}):\n${lines.join("\n")}`;
    } catch (err) {
      return `desktop_processes failed: ${err}`;
    }
  }

  private async handleDesktopQuitApp(name?: string, pid?: number, strategy?: string): Promise<string> {
    try {
      if (!name && !pid) return "desktop_quit_app requires either 'name' or 'pid' parameter";
      const strat = (strategy as "graceful" | "force") || "graceful";

      if (pid) {
        const result = computerQuitProcess(pid, strat);
        if (!result.ok) return `desktop_quit_app failed: ${result.error}`;
        return `Quit PID ${pid} (${strat})`;
      } else {
        const result = computerQuitByName(name!, strat);
        if (!result.ok) return `desktop_quit_app failed: ${result.error}`;
        return `Quit "${name}" (${strat})`;
      }
    } catch (err) {
      return `desktop_quit_app failed: ${err}`;
    }
  }

  private async handleDesktopSuggestQuit(): Promise<string> {
    try {
      const { apps, safeList, memSummary } = computerSuggestQuittable();
      const memLine = `Memory: ${memSummary.usedMB}/${memSummary.totalMB} MB (${memSummary.usedPercent}% used, ${memSummary.freeMB} MB free)`;

      if (apps.length === 0) {
        return `${memLine}\nNo quittable apps found - everything is either system-critical or on the safe list.`;
      }

      const lines = apps.slice(0, 15).map((p, i) =>
        `${String(i + 1).padStart(2)}. ${p.name.padEnd(25)} ${String(p.memoryMB).padStart(6)} MB  (PID ${p.pid})`
      );

      const totalFreeable = apps.slice(0, 15).reduce((sum, p) => sum + p.memoryMB, 0);
      const safeNote = safeList.length > 0 ? `\nSafe list (protected): ${safeList.join(", ")}` : "";

      return `${memLine}\n\nApps that could be quit to free resources:\n${lines.join("\n")}\n\nPotential savings: ~${totalFreeable} MB${safeNote}\n\nUse desktop_quit_app to quit specific apps (requires confirmation).`;
    } catch (err) {
      return `desktop_suggest_quit failed: ${err}`;
    }
  }

  private async handleDesktopSafeList(action: string, app?: string): Promise<string> {
    try {
      if (action === "list") {
        const list = computerLoadSafeList();
        if (list.length === 0) return "Safe list is empty. Add apps with action='add' to protect them from being quit.";
        return `Safe list (${list.length} apps protected):\n${list.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
      } else if (action === "add") {
        if (!app) return "desktop_safe_list add requires 'app' parameter";
        return computerAddToSafeList(app);
      } else if (action === "remove") {
        if (!app) return "desktop_safe_list remove requires 'app' parameter";
        return computerRemoveFromSafeList(app);
      }
      return `Unknown safe list action: ${action}. Use 'list', 'add', or 'remove'.`;
    } catch (err) {
      return `desktop_safe_list failed: ${err}`;
    }
  }

  // ============================================
  // Browser Harness Tools (CDP-first with fallback)
  // ============================================

  private browserHarness: BrowserHarness | null = null;

  private async ensureBrowserHarness(options?: {
    headless?: boolean;
    remoteWsUrl?: string;
  }): Promise<BrowserHarness> {
    if (this.browserHarness?.ready) return this.browserHarness;

    const harness = new BrowserHarness({
      headless: options?.headless,
      remoteWsUrl: options?.remoteWsUrl,
    });
    const strategy = await harness.init();
    this.browserHarness = harness;
    return harness;
  }

  private async handleBrowserOpen(
    url: string,
    headless?: boolean,
    remoteWsUrl?: string
  ): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness({ headless, remoteWsUrl });
      const page = await harness.navigate(url);
      const strategy = harness.activeStrategy;

      const lines = [
        `[strategy: ${strategy}]`,
        `URL: ${page.url}`,
        `Title: ${page.title}`,
      ];

      if (page.links?.length) {
        lines.push(`\nLinks (${page.links.length}):`);
        for (const link of page.links.slice(0, 20)) {
          lines.push(`  [${link.index}] ${link.text} -> ${link.href}`);
        }
      }

      if (page.inputs?.length) {
        lines.push(`\nInputs (${page.inputs.length}):`);
        for (const input of page.inputs.slice(0, 15)) {
          lines.push(`  [${input.index}] <${input.tag}> type=${input.type || "text"} name=${input.name || ""} placeholder="${input.placeholder || ""}"`);
        }
      }

      if (page.text) {
        lines.push(`\nPage text (first 2000 chars):\n${page.text.slice(0, 2000)}`);
      }

      return lines.join("\n");
    } catch (err) {
      return `browser_open failed: ${err}`;
    }
  }

  private async handleBrowserState(): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness();
      const page = await harness.readPage();
      const elements = await harness.getElements();

      const lines = [
        `[strategy: ${harness.activeStrategy}]`,
        `URL: ${page.url}`,
        `Title: ${page.title}`,
      ];

      if (elements.length) {
        lines.push(`\nInteractive elements (${elements.length}):`);
        for (const el of elements.slice(0, 40)) {
          const desc = [el.tag];
          if (el.type) desc.push(`type=${el.type}`);
          if (el.href) desc.push(`href=${el.href}`);
          if (el.role) desc.push(`role=${el.role}`);
          lines.push(`  [${el.index}] <${desc.join(" ")}> "${el.text.slice(0, 60)}" -> ${el.selector}`);
        }
      }

      if (page.text) {
        lines.push(`\nPage text (first 2000 chars):\n${page.text.slice(0, 2000)}`);
      }

      return lines.join("\n");
    } catch (err) {
      return `browser_state failed: ${err}`;
    }
  }

  private async handleBrowserClick(
    selector?: string,
    x?: number,
    y?: number
  ): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness();
      if (selector) {
        await harness.click(selector);
        return `Clicked: ${selector}`;
      }
      if (x !== undefined && y !== undefined) {
        await harness.click({ x, y });
        return `Clicked at (${x}, ${y})`;
      }
      return "Error: provide either selector or x,y coordinates";
    } catch (err) {
      return `browser_click failed: ${err}`;
    }
  }

  private async handleBrowserType(text: string, selector?: string): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness();
      await harness.type(text, selector);
      return `Typed "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"${selector ? ` into ${selector}` : ""}`;
    } catch (err) {
      return `browser_type failed: ${err}`;
    }
  }

  private async handleBrowserEval(expression: string): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness();
      return await harness.evaluate(expression);
    } catch (err) {
      return `browser_eval failed: ${err}`;
    }
  }

  private async handleBrowserScreenshot(
    filePath?: string,
    format?: string
  ): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness();
      const data = await harness.screenshot({
        format: format === "jpeg" ? "jpeg" : "png",
      });

      if (filePath) {
        const fs = await import("fs");
        const buffer = Buffer.from(data, "base64");
        fs.writeFileSync(filePath, buffer);
        return `Screenshot saved to ${filePath} (${buffer.length} bytes)`;
      }

      return `data:image/${format || "png"};base64,${data.slice(0, 200)}... (${data.length} chars base64)`;
    } catch (err) {
      return `browser_screenshot failed: ${err}`;
    }
  }

  private async handleBrowserScroll(
    direction?: string,
    amount?: number
  ): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness();
      const dir = direction === "up" ? "up" : "down";
      await harness.scroll(dir, amount);
      return `Scrolled ${dir}${amount ? ` ${amount}px` : ""}`;
    } catch (err) {
      return `browser_scroll failed: ${err}`;
    }
  }

  private async handleBrowserElements(): Promise<string> {
    try {
      const harness = await this.ensureBrowserHarness();
      const elements = await harness.getElements();

      if (!elements.length) {
        return "No interactive elements found (harness may be in fetch-only mode)";
      }

      const lines = [`Interactive elements (${elements.length}):`];
      for (const el of elements) {
        const desc = [el.tag];
        if (el.type) desc.push(`type=${el.type}`);
        if (el.href) desc.push(`href=${el.href}`);
        lines.push(`  [${el.index}] <${desc.join(" ")}> "${el.text.slice(0, 60)}" -> ${el.selector}`);
      }
      return lines.join("\n");
    } catch (err) {
      return `browser_elements failed: ${err}`;
    }
  }

  private async handleBrowserClose(): Promise<string> {
    try {
      if (this.browserHarness) {
        const strategy = this.browserHarness.activeStrategy;
        await this.browserHarness.close();
        this.browserHarness = null;
        return `Browser harness closed (was using: ${strategy})`;
      }
      return "No active browser harness";
    } catch (err) {
      return `browser_close failed: ${err}`;
    }
  }

  // ============================================
  // Trading Tools (Polymarket)
  // ============================================

  private tradingEngine: TradingEngine | null = null;
  private polyClient: PolymarketClient | null = null;

  private ensureTrading(): { client: PolymarketClient; engine: TradingEngine } {
    if (!this.polyClient) {
      this.polyClient = new PolymarketClient();
    }
    if (!this.tradingEngine) {
      this.tradingEngine = new TradingEngine(this.polyClient);
    }
    return { client: this.polyClient, engine: this.tradingEngine };
  }

  private async handleTradeBrowse(query?: string, limit?: number): Promise<string> {
    try {
      const { client } = this.ensureTrading();
      const markets = query
        ? await client.searchMarkets(query, limit || 10)
        : await client.getTopMarkets(limit || 10);

      if (!markets.length) {
        return query ? `No markets found for "${query}"` : "No active markets found";
      }

      const lines = [`Polymarket Markets${query ? ` matching "${query}"` : " (top by volume)"}:\n`];
      for (let i = 0; i < markets.length; i++) {
        lines.push(`[${i + 1}] ${PolymarketClient.formatMarket(markets[i])}`);
        lines.push(`    ID: ${markets[i].id}`);
        lines.push("");
      }
      return lines.join("\n");
    } catch (err) {
      return `trade_browse failed: ${err}`;
    }
  }

  private async handleTradeMarket(marketId: string): Promise<string> {
    try {
      const { client } = this.ensureTrading();
      const market = await client.getMarket(marketId);

      const lines = [
        `--- ${market.question} ---`,
        `ID: ${market.id}`,
        `Active: ${market.active} | Closed: ${market.closed}`,
        `Volume: $${parseFloat(market.volume || "0").toLocaleString()}`,
        `Liquidity: $${parseFloat(market.liquidity || "0").toLocaleString()}`,
        "",
        "Outcomes:",
      ];

      const { outcomes, prices, tokenIds } = parseMarketArrays(market);
      for (let i = 0; i < outcomes.length; i++) {
        const price = prices[i] || 0;
        lines.push(`  ${outcomes[i]}: ${(price * 100).toFixed(1)}%`);

        // Get orderbook if token IDs available
        if (tokenIds[i]) {
          try {
            const spread = await client.getSpread(tokenIds[i]);
            lines.push(`    Bid: ${(spread.bid * 100).toFixed(1)}c | Ask: ${(spread.ask * 100).toFixed(1)}c | Spread: ${(spread.spread * 100).toFixed(1)}c`);
          } catch {}
        }
      }

      if (market.description) {
        lines.push("", `Description: ${market.description.slice(0, 300)}`);
      }

      return lines.join("\n");
    } catch (err) {
      return `trade_market failed: ${err}`;
    }
  }

  private async handleTradeOpportunities(limit?: number): Promise<string> {
    try {
      const { engine } = this.ensureTrading();
      const opps = await engine.findOpportunities(limit || 5);

      if (!opps.length) {
        return "No trading opportunities found";
      }

      const lines = ["Top Trading Opportunities (scored by volume, liquidity, odds):\n"];
      for (let i = 0; i < opps.length; i++) {
        lines.push(`[${i + 1}] Score: ${opps[i].score}/65`);
        lines.push(`    ${opps[i].formatted}`);
        lines.push(`    ID: ${opps[i].market.id}`);
        lines.push("");
      }
      return lines.join("\n");
    } catch (err) {
      return `trade_opportunities failed: ${err}`;
    }
  }

  private async handleTradeBuy(
    marketId: string,
    outcome: string,
    size: number,
    price: number | undefined,
    confidence: number,
    reasoning: string
  ): Promise<string> {
    try {
      const { client, engine } = this.ensureTrading();
      const market = await client.getMarket(marketId);

      // Resolve price from market if not provided
      let tradePrice = price;
      if (!tradePrice) {
        const { outcomes: outs, prices: prs } = parseMarketArrays(market);
        const outcomeIdx = outs.findIndex(
          (o) => o.toLowerCase() === outcome.toLowerCase()
        );
        if (outcomeIdx >= 0 && prs[outcomeIdx] !== undefined) {
          tradePrice = prs[outcomeIdx];
        } else {
          return `Cannot determine price for outcome "${outcome}" in this market`;
        }
      }

      const intent: TradeIntent = {
        market,
        side: "BUY",
        outcome,
        price: tradePrice,
        size,
        confidence,
        reasoning,
      };

      // Check guardrails first
      const blocked = engine.checkGuardrails(intent);
      if (blocked) {
        return `[GUARDRAIL BLOCKED] ${blocked}\n\n${TradingEngine.formatIntent(intent)}`;
      }

      // In autonomous mode, execute directly
      if (engine.isAutonomous) {
        const result = await engine.executeTrade(intent);
        return TradingEngine.formatResult(result);
      }

      // Manual mode - show intent for confirmation
      return [
        TradingEngine.formatIntent(intent),
        "",
        "Guardrails: PASSED",
        "Mode: MANUAL - trade_buy again with same params to confirm, or adjust.",
        "To enable autonomous: trade_strategy with autonomous=true",
      ].join("\n");
    } catch (err) {
      return `trade_buy failed: ${err}`;
    }
  }

  private async handleTradeSell(
    marketId: string,
    outcome: string,
    size: number,
    price?: number,
    reasoning?: string
  ): Promise<string> {
    try {
      const { client, engine } = this.ensureTrading();
      const market = await client.getMarket(marketId);

      let tradePrice = price;
      if (!tradePrice) {
        const { outcomes: outs, prices: prs } = parseMarketArrays(market);
        const outcomeIdx = outs.findIndex(
          (o) => o.toLowerCase() === outcome.toLowerCase()
        );
        if (outcomeIdx >= 0 && prs[outcomeIdx] !== undefined) {
          tradePrice = prs[outcomeIdx];
        } else {
          return `Cannot determine price for outcome "${outcome}"`;
        }
      }

      const intent: TradeIntent = {
        market,
        side: "SELL",
        outcome,
        price: tradePrice,
        size,
        confidence: 0.8,
        reasoning: reasoning || "Selling position",
      };

      if (engine.isAutonomous) {
        const result = await engine.executeTrade(intent);
        return TradingEngine.formatResult(result);
      }

      return [
        TradingEngine.formatIntent(intent),
        "",
        "Mode: MANUAL - confirm to execute.",
      ].join("\n");
    } catch (err) {
      return `trade_sell failed: ${err}`;
    }
  }

  private async handleTradePositions(): Promise<string> {
    try {
      const { client } = this.ensureTrading();
      if (client.readOnly) {
        return "Read-only mode - no API credentials configured.\nSet POLYMARKET_CLOB_API_KEY, POLYMARKET_CLOB_SECRET, POLYMARKET_CLOB_PASSPHRASE in ~/.8gent/.env";
      }
      if (!client.authenticated) await client.authenticate();
      const positions = await client.getPositions();

      if (!positions.length) {
        return "No open positions";
      }

      const lines = ["Current Positions:\n"];
      for (const p of positions) {
        lines.push(`  Token: ${p.asset.token_id.slice(0, 12)}...`);
        lines.push(`  Size: ${p.size} | Avg Price: ${p.avgPrice} | Current: ${p.currentPrice}`);
        lines.push(`  P&L: ${p.pnl}`);
        lines.push("");
      }
      return lines.join("\n");
    } catch (err) {
      return `trade_positions failed: ${err}`;
    }
  }

  private async handleTradeBalance(): Promise<string> {
    try {
      const { client } = this.ensureTrading();
      if (client.readOnly) {
        return "Read-only mode - no API credentials configured.\nSet POLYMARKET_CLOB_API_KEY, POLYMARKET_CLOB_SECRET, POLYMARKET_CLOB_PASSPHRASE in ~/.8gent/.env";
      }
      if (!client.authenticated) await client.authenticate();
      const balance = await client.getBalance();
      return `USDC Balance: $${balance.toFixed(2)}`;
    } catch (err) {
      return `trade_balance failed: ${err}`;
    }
  }

  private async handleTradeStrategy(args: Partial<Record<string, unknown>>): Promise<string> {
    try {
      const { engine } = this.ensureTrading();

      // If any update params provided, update the strategy
      const updates: Partial<StrategyConfig> = {};
      if (args.max_trade_size !== undefined) updates.maxTradeSize = args.max_trade_size as number;
      if (args.max_exposure !== undefined) updates.maxExposure = args.max_exposure as number;
      if (args.min_confidence !== undefined) updates.minConfidence = args.min_confidence as number;
      if (args.min_edge !== undefined) updates.minEdge = args.min_edge as number;
      if (args.autonomous !== undefined) updates.autonomous = args.autonomous as boolean;
      if (args.max_trades_per_hour !== undefined) updates.maxTradesPerHour = args.max_trades_per_hour as number;

      if (Object.keys(updates).length > 0) {
        engine.updateStrategy(updates);
      }

      const config = engine.config;
      return [
        "Trading Strategy:",
        `  Max trade size:     $${config.maxTradeSize}`,
        `  Max exposure:       $${config.maxExposure}`,
        `  Min confidence:     ${(config.minConfidence * 100).toFixed(0)}%`,
        `  Min edge:           ${(config.minEdge * 100).toFixed(0)}%`,
        `  Autonomous:         ${config.autonomous ? "YES" : "NO (manual confirmation)"}`,
        `  Max trades/hour:    ${config.maxTradesPerHour}`,
        config.categories?.length ? `  Categories:         ${config.categories.join(", ")}` : "",
        "",
        Object.keys(updates).length > 0 ? "Strategy updated and saved to ~/.8gent/trading/strategy.json" : "Pass parameters to update.",
      ].filter(Boolean).join("\n");
    } catch (err) {
      return `trade_strategy failed: ${err}`;
    }
  }

  private async handleTradeJournal(limit?: number): Promise<string> {
    try {
      const { engine } = this.ensureTrading();
      const journal = engine.getJournal(limit || 20);
      const summary = engine.getJournalSummary();

      const lines = [
        "Trade Journal Summary:",
        `  Total trades: ${summary.totalTrades}`,
        `  Successful:   ${summary.successful}`,
        `  Blocked:      ${summary.blocked}`,
        `  Total spent:  $${summary.totalSpent.toFixed(2)}`,
        "",
      ];

      if (journal.length) {
        lines.push("Recent trades:");
        for (const t of journal.slice(-10)) {
          const status = t.success ? "OK" : "BLOCKED";
          lines.push(`  [${status}] ${t.market} | ${t.side} ${t.outcome} @ ${t.price} | $${t.size} | ${t.timestamp}`);
          if (t.error) lines.push(`         ${t.error}`);
        }
      } else {
        lines.push("No trades recorded yet.");
      }

      return lines.join("\n");
    } catch (err) {
      return `trade_journal failed: ${err}`;
    }
  }
}

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
