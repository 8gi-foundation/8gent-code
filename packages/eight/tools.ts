/**
 * 8gent Code - Tool Executor
 *
 * Defines all tools available to the agent and handles their execution.
 * This is the bridge between LLM tool calls and actual system operations.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtractVideoMode, extractVideo, formatExtractVideoResult } from "@8gent/eyes/marlin";
import {
	type FileOutline,
	type RepoIndex,
	ensureIndexed as astEnsureIndexed,
	getFileOutline as astGetFileOutline,
	getFileTree as astGetFileTree,
	getFreshFileOutline as astGetFreshFileOutline,
	listRepos as astListRepos,
	refreshIndex as astRefreshIndex,
	searchSymbols as astSearchSymbols,
} from "../ast-index";
import {
	awaitIndex,
	formatLocate,
	LOCATE_INDEX_WAIT_MS,
	locate as astLocate,
} from "../ast-index/locate";
import { PLAN_STATUSES, UPDATE_PLAN_DESCRIPTION, updatePlan } from "../ai/update-plan";
import { getSymbolSource, parseTypeScriptFile } from "../ast-index/typescript-parser";
import { killProcessTree, spawnShell } from "../core/shell";
import { deckVideoAfterWrite } from "../deck/auto";
import {
	addToSafeList as computerAddToSafeList,
	click as computerClick,
	clipboardGet as computerClipboardGet,
	clipboardSet as computerClipboardSet,
	drag as computerDrag,
	hover as computerHover,
	listProcesses as computerListProcesses,
	loadSafeList as computerLoadSafeList,
	mousePosition as computerMousePosition,
	press as computerPress,
	quitByName as computerQuitByName,
	quitProcess as computerQuitProcess,
	removeFromSafeList as computerRemoveFromSafeList,
	screenshot as computerScreenshot,
	scroll as computerScroll,
	suggestQuittable as computerSuggestQuittable,
	typeText as computerType,
	windowList as computerWindowList,
	decodeCoordMap,
	getToolDefinitions as getComputerToolDefs,
	imageToDesktop,
} from "../computer";
import { DESKTOP_POLICY_ACTION, desktopPolicyContext } from "../computer/desktop-policy";
import {
	detectDesignNeed,
	getAvailableDesignSystems,
	needsDesignDecision,
	suggestDesignSystems,
} from "../design-agent/index.js";
import {
	findByMood as findDesignByMood,
	findByStyle as findDesignByStyle,
	generateCssVariables,
	generateTailwindConfig,
	getComplete as getCompleteDesignSystem,
	getHexPalette,
	initDatabase as initDesignDb,
	listAll as listAllDesignSystems,
	listMoods as listDesignMoods,
	listStyles as listDesignStyles,
	search as searchDesignSystems_db,
	suggestForProject as suggestDesignForProject,
} from "../design-systems/index.js";
import { type HookManager, getHookManager } from "../hooks";
import { type InfiniteRunner, createInfiniteRunner, formatInfiniteState } from "../infinite";
import {
	lspDiagnostics,
	lspDocumentSymbols,
	lspFindReferences,
	lspGoToDefinition,
	lspHover,
} from "../lsp";
import { formatToolResult, getMCPClient } from "../mcp";
import { getMemoryManager } from "../memory";
import { type PermissionManager, getPermissionManager, isCommandDangerous } from "../permissions";
import {
	MakerCheckerBlockedError,
	assertMakerCheckerApproved,
} from "../permissions/maker-checker-enforcer";
import { editScopeViolation, emptyOldTextError, normaliseAllowedPaths } from "../permissions/edit-guards";
import { decideOpenOnWrite, openWrittenFile } from "./open-on-write";
import { validatePath as guardPath } from "../permissions/path-guard.js";
import { CreatedFiles, watchRedirects, watchWrite } from "../permissions/s1-created-files";
import { sanitizeShellCommand } from "../permissions/shell-sanitizer";
import { systemOneGate } from "../permissions/system-one-gate";
import {
	type PermissionModeHolder,
	currentPermissionHolder,
	currentPermissionMode,
	guardedSkipsCard,
	planModeRefusal,
	runWithPermissionHolder,
	systemOneEnvFor,
} from "../permissions/permission-mode";
import {
	ALLOWED_PATHS_DESCRIPTION,
	CHECK_AGENT_DESCRIPTION,
	PERMISSION_MODE_DESCRIPTION,
	LIST_AGENTS_DESCRIPTION,
	SPAWN_AGENT_DESCRIPTION,
	checkAgentTool,
	listAgentsTool,
	spawnAgentTool,
} from "../orchestration/delegation-tools";
import { MCP_POLICY_ACTION, askMcpApproval, mcpPolicyContext } from "../permissions/mcp-gate";
import { ToolG8 } from "../permissions/toolg8.js";
import { hasTuiApprovalHandler, requestTuiApproval } from "../permissions/tui-approval-channel";
import {
	WRITE_CONTENT_TOOLS,
	applyEdit,
	blockedToolMessage,
	writtenContentFor,
} from "../permissions/write-content-gate.js";
import type { PolicyActionType } from "../permissions/types.js";
import { formatTaskOutput, formatTaskStatus, getBackgroundTaskManager } from "../tools/background";
import { browserOpen, browserScreenshot, browserState, browserTask } from "../tools/browser-use";
import { describeImage, readImage } from "../tools/image";
import { deleteCell, editCell, insertCell, readNotebook } from "../tools/notebook";
import { readPdf, readPdfPage, searchPdf } from "../tools/pdf";
import { RateLimiter } from "../tools/rate-limiter";
import {
	vercelDeploy,
	vercelGetDeploymentLogs,
	vercelGetDeployments,
	vercelGetEnv,
	vercelListDomains,
	vercelListProjects,
	vercelSetEnv,
} from "../tools/vercel";
import { formatFetchResult, formatSearchResults, webFetch, webSearch } from "../tools/web";
import { ArtifactStore } from "./artifact-store";
import { scrub as scrubSecrets } from "./secret-scanner";
import { executeTermTool, getTermToolDefs, isTermTool } from "./term-tools.js";

/**
 * Validate that a user-provided path stays within the working directory.
 * Prevents path traversal attacks (../../etc/passwd).
 * Always normalizes the raw input - no pre-processing should be done by callers.
 */
function safePath(userPath: string, workingDirectory: string): string {
	// Static credential / UNC / device guard runs FIRST so a misconfigured
	// workspace boundary cannot expose protected paths. Issue #2465.
	const guard = guardPath(userPath, workingDirectory);
	if (!guard.ok) {
		throw new Error(`Path blocked by path-guard: ${guard.reason} ("${userPath}")`);
	}

	// Expand a leading `~` to the real home directory BEFORE normalizing, so a
	// model-supplied "~/notes.txt" resolves to the actual home path instead of
	// a literal "./~" directory (issue #2747, secondary).
	const expanded =
		userPath === "~"
			? os.homedir()
			: userPath.startsWith("~/")
				? path.join(os.homedir(), userPath.slice(2))
				: userPath;

	// Normalize first to collapse ../ sequences before resolving
	const normalized = path.normalize(expanded);
	const absolutePath = path.isAbsolute(normalized)
		? path.resolve(normalized)
		: path.resolve(workingDirectory, normalized);

	const normalizedBase = path.resolve(workingDirectory);
	const normalizedTarget = path.resolve(absolutePath);

	// Allow the working directory itself
	if (normalizedTarget === normalizedBase) return normalizedTarget;

	// Must be inside the working directory
	if (!normalizedTarget.startsWith(normalizedBase + path.sep)) {
		throw new Error(
			`Path traversal blocked: "${userPath}" resolves outside working directory. ` +
				`Files can only be read or written inside ${normalizedBase} - use a path inside that directory.`,
		);
	}

	return normalizedTarget;
}

/**
 * Execute a git command safely using spawn with argument arrays.
 * Prevents shell injection from LLM-generated arguments.
 */
const GIT_NON_INTERACTIVE_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "/usr/bin/true",
	SSH_ASKPASS: "/usr/bin/true",
	SSH_ASKPASS_REQUIRE: "force",
	GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=no",
};

const SPAWN_NON_INTERACTIVE_ENV = {
	...GIT_NON_INTERACTIVE_ENV,
	DEBIAN_FRONTEND: "noninteractive",
	NPM_CONFIG_YES: "true",
};

function spawnGit(args: string[], cwd: string): Promise<string> {
	const TIMEOUT_MS = 30_000;
	return new Promise(async (resolve) => {
		const { spawn } = await import("node:child_process");
		const proc = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			env: { ...process.env, ...GIT_NON_INTERACTIVE_ENV },
		});
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		const timer = setTimeout(() => {
			killProcessTree(proc.pid, "SIGKILL");
			resolve(`TIMEOUT after ${TIMEOUT_MS / 1000}s: git ${args[0]}`);
		}, TIMEOUT_MS);
		const finish = (code: number | null) => {
			clearTimeout(timer);
			resolve(code === 0 ? stdout.trim() : `Error (exit ${code}): ${stderr.trim()}`);
		};
		proc.on("close", finish);
		proc.on("error", (err: Error) => {
			clearTimeout(timer);
			resolve(`Error: ${err.message}`);
		});
		proc.unref();
	});
}

// read_file line numbers (#3375): the `cat -n` gutter, a right-aligned number
// and a tab. Models cite line numbers from it instead of counting by hand.
// Exactly what numberLines emits: the number right-aligned in 6 columns (or
// wider past 999999), then a tab. A TSV row like "2024\tbudget" is not it.
const GUTTER = /^(?: {5}\d| {4}\d{2}| {3}\d{3}| {2}\d{4}| \d{5}|\d{6,})\t/;

/** Number `lines` as `cat -n` does, the first one being line `first`. */
export function numberLines(lines: string[], first: number): string {
	return lines.map((line, i) => `${String(first + i).padStart(6)}\t${line}`).join("\n");
}

/** True when every non-empty line of `text` starts with a read_file gutter. */
export function hasLineNumberGutter(text: string): boolean {
	const rows = text.split("\n").filter((l) => l.trim() !== "");
	return rows.length > 0 && rows.every((l) => GUTTER.test(l));
}

/** A positive integer from a model-supplied argument, or undefined. */
function positiveInt(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 1 ? n : undefined;
}

export class ToolExecutor {
	private workingDirectory: string;
	private permissionManager: PermissionManager;
	private hookManager: HookManager;
	private toolG8: ToolG8;
	private agentId: string;
	private astIndexReady = false;
	private astRepoId: string | null = null;
	private astIndexPromise: Promise<RepoIndex> | null = null;
	private artifactStore: ArtifactStore;
	/**
	 * Whether this executor runs unattended (autonomous engine / infinite mode /
	 * heartbeat). When true, destructive tools are gated by the maker-checker at
	 * executeRaw. Interactive executors leave this false so human-approved flows
	 * are never blocked. See packages/permissions/maker-checker-enforcer.ts.
	 */
	private unattended: boolean;
	/**
	 * Files (or directories) this agent may write and edit, from spawn_agent's
	 * `allowedPaths` (#3101). Undefined means no limit (the default).
	 */
	private allowedPaths: string[] | undefined;
	/**
	 * Whether write_file may open a written deliverable for the user (#3107).
	 * False for agents the agent pool spawns.
	 */
	private openOnWrite: boolean;
	/** Paths write_file opened this turn: each opens at most once per turn. */
	private openedThisTurn = new Set<string>();
	/**
	 * Files this agent created (write_file, run_command redirects), in memory
	 * only (#3177). System One lets it rm them without the judge. The Agent
	 * hands the same record to its native tool context, so both tool paths
	 * share it; another agent or tab has its own.
	 */
	readonly createdFiles = new CreatedFiles();
	/**
	 * This agent's permission mode (#3170), shared with its Agent and, in the
	 * TUI, with its tab. Undefined: no mode, today's behaviour.
	 */
	private permission: PermissionModeHolder | undefined;

	constructor(
		workingDirectory: string = process.cwd(),
		agentId = "primary",
		sessionId?: string,
		options: {
			unattended?: boolean;
			allowedPaths?: string[];
			openOnWrite?: boolean;
			permission?: PermissionModeHolder;
		} = {},
	) {
		this.workingDirectory = workingDirectory;
		this.permission = options.permission;
		this.agentId = agentId;
		this.unattended = options.unattended ?? false;
		this.allowedPaths = normaliseAllowedPaths(options.allowedPaths);
		this.openOnWrite = options.openOnWrite ?? true;
		this.toolG8 = ToolG8.instance();
		this.permissionManager = getPermissionManager();
		this.hookManager = getHookManager();
		// Per-executor artifact store. Default sessionId derives from
		// agentId + pid so two long-lived executors in one process never
		// collide. Callers (agent.ts, mcp/server.ts) can pass an explicit
		// sessionId to thread it through to disk for later inspection.
		this.artifactStore = new ArtifactStore(sessionId ?? `${agentId}-${process.pid}`);

		// Background AST indexing of the working directory. The build yields to
		// the event loop between batches of files, so the constructor returns
		// at once. ensureIndexed shares one build per folder per process, keyed
		// by absolute path, so the agent and every executor on the same
		// directory reuse it instead of re-indexing.
		this.astIndexPromise = astEnsureIndexed(this.workingDirectory)
			.then((index) => {
				this.astIndexReady = true;
				this.astRepoId = index.id;
				return index;
			})
			.catch(() => {
				this.astIndexReady = false;
				return null as any;
			});
	}

	getWorkingDirectory(): string {
		return this.workingDirectory;
	}

	/** A new turn starts: files may be opened once again (#3107). */
	beginTurn(): void {
		this.openedThisTurn.clear();
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
					description:
						"[CODE] Returns a list of all symbols (functions, classes, types, exports) in a file with their line numbers and signatures. Use this FIRST before read_file to understand file structure - much cheaper than reading the whole file. Typically followed by get_symbol to extract just the function you need. If the file is not indexed, falls back to AST parsing.",
					parameters: {
						type: "object",
						properties: {
							filePath: {
								type: "string",
								description: "Path to the file to analyze",
							},
						},
						required: ["filePath"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "get_symbol",
					description:
						"[CODE] Returns the full source code of a single symbol (function, class, variable, type) by ID. Use this after get_outline to extract exactly the code you need without reading the entire file. Typically used after get_outline or search_symbols. If the symbol is not found, check the ID format: 'path/to/file.ts::symbolName'.",
					parameters: {
						type: "object",
						properties: {
							symbolId: {
								type: "string",
								description: "Symbol ID in format 'path/to/file.ts::symbolName'",
							},
						},
						required: ["symbolId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "search_symbols",
					description:
						"[CODE] Returns matching symbol names, locations, and kinds across the entire indexed codebase. Use this when you know what you are looking for but not where it lives. Prefer this over reading multiple files to find a function. If no results, try broader query terms or check that the project is indexed with get_project_outline.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Search query" },
							kinds: {
								type: "array",
								items: { type: "string" },
								description: "Filter by kinds: function, class, method, variable",
							},
						},
						required: ["query"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "locate",
					description:
						'[CODE] Answers "where is X?" in one call with at most 5 "file:line kind text" rows. Give it a symbol name (createDecider, Foo::bar), a path or file name (decide/rules.ts), a quoted string or error message, or a short description. It picks symbol, path or text search itself. Use this FIRST to find where something lives, then get_symbol or read_file on the row you need.',
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description:
									"Symbol name, path fragment, quoted text, error message or short description",
							},
						},
						required: ["query"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "update_plan",
					description: UPDATE_PLAN_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							plan: {
								type: "array",
								description: "Every step, in order",
								items: {
									type: "object",
									properties: {
										step: { type: "string" },
										status: { type: "string", enum: [...PLAN_STATUSES] },
									},
									required: ["step", "status"],
								},
							},
						},
						required: ["plan"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "get_project_outline",
					description:
						"[CODE] Returns a compact map of every indexed file in the project with symbol counts and names. Use this FIRST when starting work on an unfamiliar codebase to understand its structure. Much faster than listing directories and reading files individually. Follow up with get_outline on specific files of interest.",
					parameters: {
						type: "object",
						properties: {},
					},
				},
			},
			// File operations
			{
				type: "function",
				function: {
					name: "read_file",
					description:
						"[FILE] Returns the text of a file at the given path, one line per row, each row starting with its line number and a tab (like `cat -n`). The number and tab are not part of the file: cite them as line numbers, but never copy them into edit_file oldText or newText. Use offset and limit to read part of a file; the numbers stay the file's real line numbers. For large files (>500 lines), prefer get_outline first to find the specific function, then get_symbol for just that code. For config files (package.json, tsconfig.json, etc.) this is the right choice directly.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the file to read" },
							offset: {
								type: "number",
								description: "Line number to start reading from (1-based). Optional.",
							},
							limit: {
								type: "number",
								description: "How many lines to read from offset. Optional.",
							},
						},
						required: ["path"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "write_file",
					description:
						"[FILE] Creates a new file or completely overwrites an existing file with the given content. Use when creating new files or rewriting an entire file. Prefer edit_file for surgical changes to existing files. ALWAYS use relative paths (e.g. 'server.ts', 'src/index.ts'). NEVER use absolute paths. If the parent directory does not exist, this will fail - use run_command to mkdir first.",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description:
									"Relative path to the file (e.g. 'server.ts', NOT '/project/server.ts')",
							},
							content: { type: "string", description: "Content to write" },
						},
						required: ["path", "content"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "edit_file",
					description:
						"[FILE] Returns confirmation after replacing an exact text match in a file with new text. Use this for surgical edits to existing files - prefer over write_file when changing a specific function or block. The oldText must match exactly (whitespace-sensitive). If the match fails, read_file first to get the exact current content, then retry.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the file" },
							oldText: {
								type: "string",
								description: "Text to find and replace",
							},
							newText: { type: "string", description: "Replacement text" },
						},
						required: ["path", "oldText", "newText"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "list_files",
					description:
						"[FILE] Returns a list of filenames and directories at the given path, optionally filtered by glob pattern. Use this to explore project structure or find files by name pattern. For finding files by content, use search_symbols or run_command with grep instead.",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "Directory path (default: current directory)",
							},
							pattern: {
								type: "string",
								description: "Glob pattern to filter files",
							},
						},
					},
				},
			},
			// Git operations
			{
				type: "function",
				function: {
					name: "git_status",
					description:
						"[GIT] Returns the working tree status: modified, staged, untracked, and deleted files. Use this before git_add or git_commit to see what has changed. Also useful after edits to verify your changes landed in the right files.",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function",
				function: {
					name: "git_diff",
					description:
						"[GIT] Returns the line-by-line diff of changes. Use without 'staged' to see unstaged working tree changes; use with staged=true to review what will be included in the next commit. Typically used after git_status to inspect specific changes before committing.",
					parameters: {
						type: "object",
						properties: {
							staged: {
								type: "boolean",
								description: "Show staged changes only",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "git_log",
					description:
						"[GIT] Returns recent commit hashes, messages, authors, and dates. Use this to understand project history, find when a change was introduced, or check commit message conventions before writing your own. Defaults to 10 commits.",
					parameters: {
						type: "object",
						properties: {
							count: {
								type: "number",
								description: "Number of commits to show (default: 10)",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "git_add",
					description:
						"[GIT] Stages files for the next commit. Use after making edits and before git_commit. Pass specific file paths to stage selectively, or omit to stage all changes. Typically used after git_status confirms the right files were modified.",
					parameters: {
						type: "object",
						properties: {
							files: {
								type: "string",
								description: "Files to add (default: all)",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "git_commit",
					description:
						"[GIT] Creates a git commit with the staged changes and returns the commit hash. Use after git_add. If nothing is staged, this will fail - run git_status first to verify staged files. Follow the project's commit message conventions (check git_log for examples).",
					parameters: {
						type: "object",
						properties: {
							message: { type: "string", description: "Commit message" },
						},
						required: ["message"],
					},
				},
			},
			// Shell
			{
				type: "function",
				function: {
					name: "run_command",
					description:
						"[SHELL] Executes a shell command and returns stdout/stderr. Use for: running tests, installing packages, checking versions, building projects, file operations (mkdir, mv, cp). Pipes (|) and redirects (>) are allowed. Command chaining (;, &&, ||) and background execution (&) are blocked for safety - use separate calls instead. If a command is blocked by permissions, simplify it or split into multiple calls.",
					parameters: {
						type: "object",
						properties: {
							command: { type: "string", description: "Command to run" },
						},
						required: ["command"],
					},
				},
			},
			// Multi-agent orchestration
			{
				type: "function",
				function: {
					name: "spawn_agent",
					description: SPAWN_AGENT_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description: "Task description for the background agent to execute",
							},
							runtime: {
								type: "string",
								enum: ["8gent", "claude", "shell"],
								description: "Runtime: '8gent' (default), 'claude' (Claude CLI), 'shell' (sh -c)",
							},
							model: {
								type: "string",
								description:
									"Model to use (only for 8gent runtime). Use 'auto:free' to automatically pick the best free model from OpenRouter.",
							},
							timeout: {
								type: "number",
								description: "Timeout in ms (default: 5 min, only for claude/shell)",
							},
							allowedPaths: {
								type: "array",
								items: { type: "string" },
								description: ALLOWED_PATHS_DESCRIPTION,
							},
							permissionMode: {
								type: "string",
								enum: ["plan", "ask", "guarded", "infinite"],
								description: PERMISSION_MODE_DESCRIPTION,
							},
						},
						required: ["task"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "check_agent",
					description: CHECK_AGENT_DESCRIPTION,
					parameters: {
						type: "object",
						properties: {
							agentId: {
								type: "string",
								description: "Agent ID returned from spawn_agent",
							},
						},
						required: ["agentId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "list_agents",
					description: LIST_AGENTS_DESCRIPTION,
					parameters: { type: "object", properties: {} },
				},
			},
			// Web tools
			{
				type: "function",
				function: {
					name: "web_search",
					description:
						"[WEB] Returns a list of search results (titles, URLs, snippets) from DuckDuckGo. Use when you need to find documentation, look up error messages, or research a topic. Follow up with web_fetch on a specific result URL to get full page content. If results are poor, try rephrasing with more specific technical terms.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "Search query" },
							maxResults: {
								type: "number",
								description: "Max results (default: 5)",
							},
						},
						required: ["query"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "web_fetch",
					description:
						"[WEB] Returns the text content of a web page at the given URL (HTML stripped to readable text). Use after web_search to read a specific page, or directly when you have a known URL (docs, GitHub, npm). Results are cached to disk. If the page is too large, only the first portion is returned.",
					parameters: {
						type: "object",
						properties: {
							url: { type: "string", description: "URL to fetch" },
						},
						required: ["url"],
					},
				},
			},
			// PDF tools
			{
				type: "function",
				function: {
					name: "read_pdf",
					description:
						"[FILE] Reads a PDF file and returns extracted text content, page count, and metadata (title, author, dates). Use for analyzing PDF documents, contracts, reports, or papers. For large PDFs, use read_pdf_page to read specific pages. Follow up with search_pdf to find specific content within a PDF.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the PDF file" },
						},
						required: ["path"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "read_pdf_page",
					description:
						"[FILE] Reads a specific page from a PDF file and returns its text content. Use when you only need content from certain pages of a large PDF, or when the full PDF text was truncated. Page numbers start at 1.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the PDF file" },
							pageNum: {
								type: "number",
								description: "Page number to read (1-based)",
							},
						},
						required: ["path", "pageNum"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "search_pdf",
					description:
						"[FILE] Searches for text within a PDF file and returns matching positions with surrounding context. Use when you need to find specific content, keywords, or phrases in a PDF without reading the entire document.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the PDF file" },
							query: { type: "string", description: "Text to search for" },
							caseSensitive: {
								type: "boolean",
								description: "Case-sensitive search (default: false)",
							},
						},
						required: ["path", "query"],
					},
				},
			},
			// Video ingestion tool (VIDEO-INGESTION spec §6).
			// Always advertised so the model can discover it; the capability is
			// OFF BY DEFAULT (spec §11) and the handler returns a structured
			// "install required" error rather than silently no-opping.
			{
				type: "function",
				function: {
					name: "extract_video",
					description:
						"[VIDEO] Extracts structured information from a video file: a scene summary, timestamped visual events, and a speech transcript. Use to understand screen recordings, demos, meetings, or clips, or to ingest a video into the knowledge graph. Runs fully local on-device. Requires the video-understanding capability to be installed (8gent vision install).",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Path to the video file" },
							mode: {
								type: "string",
								enum: ["full", "visual", "audio"],
								description:
									"full = events + transcript (default); visual = events only; audio = transcript only",
							},
							query: {
								type: "string",
								description:
									"Optional natural-language event to locate; returns the matching time span",
							},
							ingest: {
								type: "boolean",
								description: "If true, write the result into the knowledge graph (default false)",
							},
						},
						required: ["path"],
					},
				},
			},
			// Vercel deployment tools
			{
				type: "function",
				function: {
					name: "vercel_list_projects",
					description:
						"[DEPLOY] Returns all Vercel projects with IDs, names, frameworks, and last update times. Use this to discover project IDs needed by other vercel_ tools. Requires VERCEL_TOKEN env var.",
					parameters: { type: "object", properties: {} },
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_get_deployments",
					description:
						"[DEPLOY] Returns recent deployments for a Vercel project including state, URL, and commit message. Use after vercel_list_projects to check deployment status.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
							limit: {
								type: "number",
								description: "Number of deployments to return (default: 5)",
							},
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_deploy",
					description:
						"[DEPLOY] Triggers a redeployment of the latest deployment for a Vercel project. Returns the new deployment ID and URL.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_set_env",
					description:
						"[DEPLOY] Creates or updates an environment variable on a Vercel project. Value is stored encrypted. Targets production, preview, and development by default.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
							key: { type: "string", description: "Environment variable name" },
							value: {
								type: "string",
								description: "Environment variable value",
							},
							target: {
								type: "array",
								items: { type: "string" },
								description: "Targets: production, preview, development (default: all)",
							},
						},
						required: ["projectId", "key", "value"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_get_env",
					description:
						"[DEPLOY] Returns all environment variables for a Vercel project (keys and targets only, values are encrypted).",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_list_domains",
					description:
						"[DEPLOY] Returns all custom domains configured for a Vercel project with verification status.",
					parameters: {
						type: "object",
						properties: {
							projectId: { type: "string", description: "Vercel project ID" },
						},
						required: ["projectId"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "vercel_get_deployment_logs",
					description:
						"[DEPLOY] Returns build/runtime logs for a specific deployment. Use the deployment ID from vercel_get_deployments.",
					parameters: {
						type: "object",
						properties: {
							deploymentId: {
								type: "string",
								description: "Deployment ID (uid from vercel_get_deployments)",
							},
						},
						required: ["deploymentId"],
					},
				},
			},
			// Design tools
			{
				type: "function",
				function: {
					name: "suggest_design",
					description:
						"[DESIGN] Returns design system recommendations including color palettes, typography, and component libraries matched to your task. Use this BEFORE writing any UI code to get curated design guidance. Typically the first design tool to call - follow up with query_design_system for specific palette/component details. Prefer this over guessing colors or fonts.",
					parameters: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description:
									"Description of the UI task or project (e.g., 'build a landing page', 'create a dashboard')",
							},
							projectType: {
								type: "string",
								description:
									"Optional project type hint: ai, saas, portfolio, ecommerce, dashboard, landing-page, etc.",
							},
						},
						required: ["task"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "query_design_system",
					description:
						"[DESIGN] Returns design system data from a curated SQLite database - palettes, typography, components, and patterns. Use when you need specific design tokens (hex colors, font stacks, spacing scales). Can output as summary, CSS variables, Tailwind config, or hex palette. Typically used after suggest_design to get implementation-ready values for a recommended system.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "Search query (e.g., 'minimal dark', 'claude', 'cyberpunk')",
							},
							style: {
								type: "string",
								description:
									"Filter by style: minimal, bold, playful, elegant, tech, retro, nature, corporate",
							},
							mood: {
								type: "string",
								description:
									"Filter by mood: professional, creative, tech, warm, cool, dramatic, calm, energetic",
							},
							output: {
								type: "string",
								description:
									"Output format: 'summary' (default), 'css' (CSS variables), 'tailwind' (Tailwind config), 'hex' (hex palette)",
							},
						},
					},
				},
			},
			// Infinite mode
			{
				type: "function",
				function: {
					name: "enable_infinite_mode",
					description:
						"[SHELL] Activates autonomous looping execution for a task and returns a runner handle. The agent will iterate until the task is complete, recovering from errors automatically. Use this when a task is too large for a single pass - e.g., refactoring across many files, running repeated test-fix cycles, or multi-step research. Set maxIterations and maxTimeMs to bound execution. If the task can be done in one shot, prefer direct tool calls instead.",
					parameters: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description: "The task to execute in infinite mode",
							},
							maxIterations: {
								type: "number",
								description: "Maximum iterations before stopping (default: 100)",
							},
							maxTimeMs: {
								type: "number",
								description: "Maximum time in ms before stopping (default: 30 minutes)",
							},
						},
						required: ["task"],
					},
				},
			},
			// Memory tools
			{
				type: "function",
				function: {
					name: "remember",
					description:
						"[MEMORY] Persists a fact to the specified memory layer and returns confirmation. Use 'session' for temporary context that disappears when the session ends. Use 'project' for facts about this codebase (persisted in .8gent/ - e.g., architecture decisions, user preferences for this repo). Use 'global' for cross-project knowledge (persisted in ~/.8gent/ - e.g., user's coding style, tool preferences). Keep facts concise and searchable. Pair with recall to retrieve later.",
					parameters: {
						type: "object",
						properties: {
							fact: { type: "string", description: "The fact to remember" },
							layer: {
								type: "string",
								enum: ["session", "project", "global"],
								description:
									"Memory layer: session (ephemeral), project (per-repo), global (cross-project)",
							},
						},
						required: ["fact", "layer"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "recall",
					description:
						"[MEMORY] Returns matching facts from all memory layers (session, project, global) ranked by relevance. Use this when you need context about the user, project conventions, past decisions, or previously learned information. Search with broad keywords first, then narrow down. If no results, try synonyms or related terms. Useful at the start of a task to check for prior context.",
					parameters: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "Search query - keywords to match against stored memories",
							},
							limit: {
								type: "number",
								description: "Max results to return (default: 10)",
							},
						},
						required: ["query"],
					},
				},
			},
			// Desktop Computer Use tools (Power #10)
			...getComputerToolDefs(),
			{
				type: "function",
				function: {
					name: "run_computer_task",
					description:
						"[DESKTOP] Run an autonomous multi-step computer-use task. The agent perceives the screen (accessibility tree first, screenshot as fallback) and uses mouse/keyboard tools to complete the goal. Use for tasks that span multiple apps or require navigating a GUI. The vision model is configured via ~/.8gent/config.json vision.computerUseModel.",
					parameters: {
						type: "object",
						properties: {
							goal: {
								type: "string",
								description: "Plain-English description of what to accomplish on the desktop.",
							},
							maxSteps: {
								type: "number",
								description: "Maximum number of agent steps (default: 20, max: 50).",
							},
						},
						required: ["goal"],
					},
				},
			},
			// Browser Use tools
			{
				type: "function",
				function: {
					name: "browser_open",
					description:
						"Open a URL in a real browser and return the page state (title, URL, clickable elements). Use for web interaction, form filling, scraping dynamic pages.",
					parameters: {
						type: "object",
						properties: {
							url: { type: "string", description: "URL to navigate to" },
							browser: {
								type: "string",
								description: "Browser to use (default: chromium). Use 'remote' for cloud browsers.",
							},
							session: {
								type: "string",
								description: "Session ID for persistent browser sessions",
							},
						},
						required: ["url"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "browser_state",
					description:
						"Get the current browser page state: URL, title, and all clickable/interactive elements with their indices. Use after browser_open to see what you can interact with.",
					parameters: {
						type: "object",
						properties: {
							session: {
								type: "string",
								description: "Session ID (if using persistent sessions)",
							},
						},
					},
				},
			},
			{
				type: "function",
				function: {
					name: "browser_task",
					description:
						"Run a complex browser task described in natural language. The browser-use agent will plan and execute multi-step interactions (clicking, typing, navigating) to complete the task.",
					parameters: {
						type: "object",
						properties: {
							task: {
								type: "string",
								description: "Natural language description of the browser task to perform",
							},
							browser: {
								type: "string",
								description: "Browser to use (default: chromium). Use 'remote' for cloud browsers.",
							},
							session: {
								type: "string",
								description: "Session ID for persistent browser sessions",
							},
						},
						required: ["task"],
					},
				},
			},
			{
				type: "function",
				function: {
					name: "browser_screenshot",
					description:
						"Take a screenshot of the current browser page. Returns the file path where the screenshot was saved.",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "File path to save screenshot (default: auto-generated)",
							},
							session: {
								type: "string",
								description: "Session ID (if using persistent sessions)",
							},
						},
					},
				},
			},
			// Windowed-session orchestration (term_*) — see packages/eight/term-tools.ts
			...getTermToolDefs(),
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
		// Notebook cell edits write text into a file too (#3011).
		notebook_edit_cell: "write_file",
		notebook_insert_cell: "write_file",
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
		// A call to any tool on an MCP server (#3230). It had no entry, so the
		// gate below never ran and every MCP call went straight to the server
		// in every mode. mcp_list_tools only reads the local list and stays
		// ungated.
		mcp_call_tool: MCP_POLICY_ACTION,
	};

	async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
		// Every call runs in this agent's permission mode (#3170), so the
		// permission layer below answers for this agent and no other.
		if (this.permission && currentPermissionHolder() !== this.permission) {
			return runWithPermissionHolder(this.permission, () => this.execute(toolName, args));
		}
		if (currentPermissionMode() === "plan") {
			const refusal = await planModeRefusal(toolName, args);
			if (refusal) return refusal;
		}
		const raw = await this.executeRaw(toolName, args);
		// Post-tool-execution scrubbing boundary (issue #2464).
		// Order is contract: SecretScanner -> [Cache lookup, #2462] -> execute
		// -> ArtifactStore persist (#2463). Scrub MUST run before persist so
		// no secret value ever lands on disk.
		const result = scrubSecrets(raw);
		if (result.redactedCount > 0) {
			// Log redaction event to telemetry (no secret values, just metadata).
			console.warn(
				`[secret-scanner] tool=${toolName} redacted=${result.redactedCount} rules=${result.rules.join(",")}`,
			);
		}
		// ArtifactStore (#2463): swap large successful results for a chip
		// reference. Failed results bypass via the `isError` flag - here the
		// scrubbed string is the model-visible payload and we have no error
		// signal at this boundary, so we treat all returns as successful.
		// The cache (#2462) sits BEFORE executeRaw and is independent of this
		// step; both can co-exist without touching each other.
		return this.artifactStore.persistAndReplace(result.scrubbed, toolName);
	}

	private async executeRaw(toolName: string, args: Record<string, unknown>): Promise<string> {
		// Maker-checker gate (safety-critical). This is the single chokepoint every
		// tool call passes through, so it runs BEFORE the term-tool early return,
		// the ToolG8 gate, and the switch. In an unattended/autonomous context a
		// destructive tool (rm, git_push, vercel_deploy, vercel_set_env,
		// enable_infinite_mode) cannot run without an approved CheckerDecision.
		// Note: this deliberately sits outside the infinite-mode permission bypass.
		try {
			assertMakerCheckerApproved(toolName, args, {
				unattended: this.unattended,
				makerId: this.agentId,
			});
		} catch (err) {
			if (err instanceof MakerCheckerBlockedError) {
				// Return a blocked marker string (matches the [..BLOCKED] contract in
				// agent.ts) so the autonomous loop records a failed tool call and
				// continues gracefully rather than crashing.
				return `[MAKER-CHECKER BLOCKED] ${err.message}`;
			}
			throw err;
		}

		// Edit scope (#3101): an agent spawned with allowedPaths writes and edits
		// only those files. Checked before anything else can touch the disk.
		const outOfScope = editScopeViolation(toolName, args, this.workingDirectory, this.allowedPaths);
		if (outOfScope) return outOfScope;

		// Rate limit check - prevents LLM loops from exhausting resources
		const rateLimitError = this.rateLimiter.check(toolName);
		if (rateLimitError) return rateLimitError;

		// ToolG8 gate - evaluate policy BEFORE any execution or delegation.
		//
		// This used to sit BELOW the term_* delegation, which returns early. So
		// every term_* tool skipped the policy check entirely and a `__table__`
		// agent - deny-by-default, read-only by design - could spawn a real tmux
		// session. Verified on clean main 2026-08-07: F3's end-to-end case asked
		// for term_spawn and got a live pane back instead of a refusal.
		//
		// The policy layer was correct the whole time; evaluatePolicy already
		// denies term_orchestration for __table__. It was simply never consulted
		// on that path. An ordering bug with the blast radius of a sandbox
		// escape.
		//
		// term_* also has no TOOL_ACTION_MAP entry, so reordering alone would
		// have left policyAction undefined and skipped the gate a SECOND way.
		// Both holes are closed here: the family maps to the capability the
		// policy engine already knows how to deny.
		// Whole FAMILIES of tools reach the switch without ever appearing in
		// TOOL_ACTION_MAP, and an unmapped tool is an ungated tool. term_* and
		// desktop_* are both control surfaces far outside what a Table officer
		// may touch, so each maps to the capability the policy engine already
		// knows how to deny rather than relying on someone remembering to add
		// every new member of the family to the map by hand.
		//
		// desktop_* is gated as `desktop_use`, the name its rules in
		// default-policies.yaml are written under, with the `action` descriptor
		// those rules match on (#3213). It was gated as `computer_use`, which
		// has no rules, so every desktop call - quitting apps included - fell
		// through to the engine's default allow and no card appeared.
		const isDesktop = toolName.startsWith("desktop_");
		const isMcpCall = toolName === "mcp_call_tool";
		const policyAction =
			ToolExecutor.TOOL_ACTION_MAP[toolName] ??
			(isTermTool(toolName)
				? "term_orchestration"
				: isDesktop
					? (DESKTOP_POLICY_ACTION as PolicyActionType)
					: undefined);
		if (policyAction) {
			const gateResult = this.toolG8.gate(this.agentId, policyAction, {
				...(isDesktop ? desktopPolicyContext(toolName, args) : {}),
				...(isMcpCall ? mcpPolicyContext(String(args.server), String(args.tool)) : {}),
				path: args.path as string,
				// Every write tool is checked on what it actually writes, not
				// only write_file's `content` (#3011: edit_file's newText was
				// never seen by no-secrets-in-files).
				content: WRITE_CONTENT_TOOLS.has(toolName)
					? writtenContentFor(toolName, args, this.workingDirectory)
					: (args.content as string),
				command: args.command as string,
				branch: args.branch as string,
				url: args.url as string,
				key: args.key as string,
			});
			const askFirst = !gateResult.allowed && gateResult.requiresApproval;
			if (askFirst && isDesktop) {
				const refusal = await this.askDesktopApproval(toolName, args, gateResult.reason);
				if (refusal) return refusal;
			} else if (askFirst && isMcpCall) {
				// Ask in Ask and Guarded; Infinite runs; no card means no call.
				const refusal = await askMcpApproval(
					String(args.server),
					String(args.tool),
					args.args as Record<string, unknown> | undefined,
					gateResult.reason,
				);
				if (refusal) return refusal;
			} else if (!gateResult.allowed) {
				// Say plainly that nothing happened (see blockedToolMessage).
				return blockedToolMessage(
					toolName,
					policyAction === "write_file",
					typeof args.path === "string" && args.path ? args.path : undefined,
					gateResult.reason,
					gateResult.alternative,
				);
			}
		}

		// Delegate windowed-session orchestration tools to their own module so the
		// giant switch below stays focused on "operate on this repo" rather than
		// "operate on a fleet of CLIs in tmux".
		//
		// Deliberately AFTER the gate. It sat above it, and that single line of
		// ordering was a sandbox escape.
		if (isTermTool(toolName)) {
			return executeTermTool(toolName, args);
		}

		switch (toolName) {
			// Code exploration
			case "get_outline":
				return this.getOutline(args.filePath as string);
			case "get_symbol":
				return this.getSymbol(args.symbolId as string);
			case "search_symbols":
				return this.searchSymbols(args.query as string, args.kinds as string[]);
			case "locate":
				return this.locate(args.query as string);
			case "update_plan":
				// Executes nothing: the plan event is the onToolStart the agent
				// fires with these args; the TUI PLAN column reads it (#3035).
				return updatePlan(args as { plan?: unknown });
			case "get_project_outline":
				return this.getProjectOutline();

			// LSP tools
			case "lsp_goto_definition":
				return lspGoToDefinition(
					args.filePath as string,
					args.line as number,
					args.character as number,
					this.workingDirectory,
				);
			case "lsp_find_references":
				return lspFindReferences(
					args.filePath as string,
					args.line as number,
					args.character as number,
					this.workingDirectory,
				);
			case "lsp_hover":
				return lspHover(
					args.filePath as string,
					args.line as number,
					args.character as number,
					this.workingDirectory,
				);
			case "lsp_document_symbols":
				return lspDocumentSymbols(args.filePath as string, this.workingDirectory);
			case "lsp_diagnostics":
				return lspDiagnostics(args.filePath as string, this.workingDirectory);

			// File operations (with path traversal protection)
			case "read_file": {
				const safe = safePath(args.path as string, this.workingDirectory);
				return this.readFile(safe, args.offset, args.limit);
			}
			case "write_file": {
				const safe = safePath(args.path as string, this.workingDirectory);
				return this.writeFile(safe, args.content as string);
			}
			case "edit_file": {
				const safe = safePath(args.path as string, this.workingDirectory);
				return this.editFile(safe, args.oldText as string, args.newText as string);
			}
			case "list_files": {
				const dir = (args.path as string) || ".";
				const safeDir = safePath(dir, this.workingDirectory);
				return this.listFiles(safeDir, args.pattern as string);
			}

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
				const files = String(args.files || ".")
					.split(/\s+/)
					.filter(Boolean);
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
				return this.runSpawn("gh", [
					"pr",
					"create",
					"--title",
					String(args.title),
					"--body",
					String(args.body || ""),
				]);
			case "gh_pr_view":
				return this.runSpawn("gh", ["pr", "view", String(args.number || "")]);
			case "gh_issue_list":
				return this.runCommand("gh issue list");
			case "gh_issue_create":
				return this.runSpawn("gh", [
					"issue",
					"create",
					"--title",
					String(args.title),
					"--body",
					String(args.body || ""),
				]);

			// Shell
			case "run_command":
				return this.runCommand(args.command as string, args.timeout as number | undefined);

			// Multi-agent orchestration
			case "spawn_agent":
				return this.handleSpawnAgent(
					args.task as string,
					args.runtime as "8gent" | "claude" | "shell" | undefined,
					args.model as string | undefined,
					args.timeout as number | undefined,
					normaliseAllowedPaths(args.allowedPaths),
					args.permissionMode,
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
			case "search_pdf":
				return this.handleSearchPdf(
					args.path as string,
					args.query as string,
					args.caseSensitive as boolean | undefined,
				);

			// Video tool (VIDEO-INGESTION spec §6)
			case "extract_video":
				return this.handleExtractVideo(
					args.path as string,
					args.mode as ExtractVideoMode | undefined,
					args.query as string | undefined,
					args.ingest as boolean | undefined,
				);

			// Notebook tools
			case "read_notebook":
				return this.handleReadNotebook(args.path as string);
			case "notebook_edit_cell":
				return this.handleNotebookEditCell(
					args.path as string,
					args.cellIndex as number,
					args.newSource as string,
				);
			case "notebook_insert_cell":
				return this.handleNotebookInsertCell(
					args.path as string,
					args.afterIndex as number,
					args.cellType as "code" | "markdown",
					args.source as string,
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
				return vercelSetEnv(
					args.projectId as string,
					args.key as string,
					args.value as string,
					args.target as string[],
				);
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
					args.args as Record<string, unknown>,
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
				return this.handleSuggestDesign(
					args.task as string,
					args.projectType as string | undefined,
				);
			case "query_design_system":
				return this.handleQueryDesignSystem(args);

			// Infinite mode
			case "enable_infinite_mode":
				return this.handleEnableInfiniteMode(
					args.task as string,
					args.maxIterations as number | undefined,
					args.maxTimeMs as number | undefined,
				);

			// Memory tools
			case "remember":
				return await this.handleRemember(
					args.fact as string,
					args.layer as "session" | "project" | "global",
				);
			case "recall":
				return await this.handleRecall(args.query as string, args.limit as number | undefined);

			// Desktop Computer Use tools (Power #10)
			case "desktop_screenshot":
				return this.handleDesktopScreenshot(
					args.path as string | undefined,
					args.displayId as number | undefined,
				);
			case "desktop_click":
				return this.handleDesktopClick(
					args.x as number,
					args.y as number,
					args.button as string | undefined,
					args.count as number | undefined,
					args.coordMap as string | undefined,
				);
			case "desktop_type":
				return this.handleDesktopType(args.text as string, args.delay as number | undefined);
			case "desktop_press":
				return this.handleDesktopPress(
					args.keys as string,
					args.count as number | undefined,
					args.delay as number | undefined,
				);
			case "desktop_scroll":
				return this.handleDesktopScroll(
					args.direction as string,
					args.amount as number | undefined,
					args.x as number | undefined,
					args.y as number | undefined,
				);
			case "desktop_drag":
				return this.handleDesktopDrag(
					args.fromX as number,
					args.fromY as number,
					args.toX as number,
					args.toY as number,
					args.button as string | undefined,
					args.duration as number | undefined,
				);
			case "desktop_hover":
				return this.handleDesktopHover(
					args.x as number,
					args.y as number,
					args.coordMap as string | undefined,
				);
			case "desktop_windows":
				return this.handleDesktopWindows();
			case "desktop_clipboard":
				return this.handleDesktopClipboard(args.action as string, args.text as string | undefined);
			case "desktop_processes":
				return this.handleDesktopProcesses(args.sort as string | undefined);
			case "desktop_quit_app":
				return this.handleDesktopQuitApp(
					args.name as string | undefined,
					args.pid as number | undefined,
					args.strategy as string | undefined,
				);
			case "desktop_suggest_quit":
				return this.handleDesktopSuggestQuit();
			case "desktop_safe_list":
				return this.handleDesktopSafeList(args.action as string, args.app as string | undefined);
			case "run_computer_task":
				return this.handleRunComputerTask(args.goal as string, args.maxSteps as number | undefined);

			// Browser Use tools
			case "browser_open":
				return this.handleBrowserOpen(
					args.url as string,
					args.browser as string | undefined,
					args.session as string | undefined,
				);
			case "browser_state":
				return this.handleBrowserState(args.session as string | undefined);
			case "browser_task":
				return this.handleBrowserTask(
					args.task as string,
					args.browser as string | undefined,
					args.session as string | undefined,
				);
			case "browser_screenshot":
				return this.handleBrowserScreenshot(
					args.path as string | undefined,
					args.session as string | undefined,
				);

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
			const outline = this.readOutline(absolutePath);
			const symbols = outline.symbols.map((s) => ({
				name: s.name,
				kind: s.kind,
				lines: `${s.startLine}-${s.endLine}`,
				signature: s.signature?.slice(0, 80),
			}));

			return JSON.stringify(
				{
					filePath: absolutePath,
					language: outline.language,
					symbolCount: symbols.length,
					symbols,
				},
				null,
				2,
			);
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
			const outline = this.readOutline(absolutePath);
			const symbol = outline.symbols.find((s) => s.name === symbolName);

			if (!symbol) {
				return `Symbol '${symbolName}' not found. Available: ${outline.symbols.map((s) => s.name).join(", ")}`;
			}

			const source = getSymbolSource(absolutePath, symbol.startLine, symbol.endLine);
			return `// ${symbol.kind}: ${symbol.name}\n// Lines ${symbol.startLine}-${symbol.endLine}\n\n${source}`;
		} catch (err) {
			return `Error: ${err}`;
		}
	}

	/**
	 * Outline for one file: the shared index when it holds the file (re-parsed
	 * in place if the file changed on disk), otherwise a direct parse.
	 */
	private readOutline(absolutePath: string): FileOutline {
		if (this.astIndexReady && this.astRepoId) {
			const rel = path.relative(this.workingDirectory, absolutePath);
			if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
				const indexed = astGetFreshFileOutline(this.astRepoId, rel);
				if (indexed) return indexed;
			}
		}
		return parseTypeScriptFile(absolutePath);
	}

	private async searchSymbols(query: string, kinds?: string[]): Promise<string> {
		if (!this.astIndexReady && this.astIndexPromise) {
			await this.astIndexPromise;
		}
		if (!this.astRepoId) {
			return JSON.stringify(
				{ query, matches: [], error: "AST index not available. Use run_command with rg instead." },
				null,
				2,
			);
		}

		const repoId = this.astRepoId;
		// Pick up files created, edited or deleted since the build (by any
		// tool, shell or editor) before ranking: one stat per file, no re-parse
		// unless the mtime moved.
		astRefreshIndex(repoId);
		const hits = astSearchSymbols(repoId, query, {
			kinds: kinds?.length ? kinds : undefined,
			limit: 20,
		});

		const matches = hits.map((symbol) => ({
			name: symbol.name,
			kind: symbol.kind,
			file: path.relative(this.workingDirectory, symbol.filePath),
			line: symbol.startLine,
		}));
		return JSON.stringify({ query, matches }, null, 2);
	}

	/**
	 * Read-only "where is X?": rules route the query to the ranked symbol
	 * index, a fuzzy path match or a literal rg search under the working
	 * directory (see ast-index/locate.ts). No model is called unless
	 * EIGHT_SYSTEM_ONE_LOCATE=1, and then only for prose the rules cannot route.
	 */
	private async locate(query: string): Promise<string> {
		// Wait for the index build only briefly: path and text search do not
		// need it, and a first call on a large repo would otherwise stall for
		// the whole build. The answer says when symbol search was skipped.
		let repoId = this.astRepoId;
		let indexPending = false;
		if (!this.astIndexReady && this.astIndexPromise) {
			const waited = await awaitIndex(
				this.astIndexPromise.then((index) => index?.id ?? null),
				LOCATE_INDEX_WAIT_MS,
			);
			repoId = waited.repoId;
			indexPending = waited.pending;
		}
		const result = await astLocate(typeof query === "string" ? query : "", {
			root: this.workingDirectory,
			repoId,
			indexPending,
		});
		return formatLocate(result);
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
				const symbolNames = outline.symbols.map((s) => `${s.kind[0]}:${s.name}`).join(", ");
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

	private async readFile(
		filePath: string,
		offsetArg?: unknown,
		limitArg?: unknown,
	): Promise<string> {
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		if (!fs.existsSync(absolutePath)) {
			return `File not found: ${absolutePath}`;
		}

		const content = fs.readFileSync(absolutePath, "utf-8");
		const lines = content.split("\n");
		// A trailing newline ends the last line; it does not start another one.
		if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
		if (content === "") return "";

		const isCodeFile = /\.(ts|tsx|js|jsx)$/.test(absolutePath);
		const offset = positiveInt(offsetArg);
		const limit = positiveInt(limitArg);

		// A slice (#3375): the numbers stay the file's real line numbers.
		if (offset !== undefined || limit !== undefined) {
			const start = offset ?? 1;
			if (start > lines.length) {
				return `File has ${lines.length} lines; offset ${start} is past the end.`;
			}
			const count = limit ?? (isCodeFile ? 200 : lines.length);
			const end = Math.min(lines.length, start - 1 + count);
			const body = numberLines(lines.slice(start - 1, end), start);
			return end < lines.length
				? `${body}\n\n[Lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]`
				: body;
		}

		// AST-first interception: for code files > 200 lines, prepend outline
		if (isCodeFile && lines.length > 200) {
			let outlineHeader = "";

			// Ensure index is ready (wait briefly if still indexing)
			if (!this.astIndexReady && this.astIndexPromise) {
				try {
					await Promise.race([
						this.astIndexPromise,
						new Promise((_, reject) => setTimeout(() => reject("timeout"), 500)),
					]);
				} catch {
					// Index not ready yet, proceed without outline
				}
			}

			if (this.astIndexReady && this.astRepoId) {
				const relativePath = path.relative(this.workingDirectory, absolutePath);
				const outline = astGetFileOutline(this.astRepoId, relativePath);
				if (outline && outline.symbols.length > 0) {
					const symbolList = outline.symbols
						.map((s) => `  ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`)
						.join("\n");
					outlineHeader = `[AST: This file has ${outline.symbols.length} symbols. Use get_symbol to fetch specific ones instead of reading the full file.]\n\nSymbols:\n${symbolList}\n\n---\n\n`;
				}
			} else {
				// Fallback: parse directly if index isn't ready
				try {
					const directOutline = parseTypeScriptFile(absolutePath);
					if (directOutline.symbols.length > 0) {
						const symbolList = directOutline.symbols
							.map((s) => `  ${s.kind} ${s.name} (L${s.startLine}-${s.endLine})`)
							.join("\n");
						outlineHeader = `[AST: This file has ${directOutline.symbols.length} symbols. Use get_symbol to fetch specific ones instead of reading the full file.]\n\nSymbols:\n${symbolList}\n\n---\n\n`;
					}
				} catch {
					// Can't parse, just return truncated content
				}
			}

			return `${outlineHeader}// File has ${lines.length} lines. Showing first 200:\n\n${numberLines(lines.slice(0, 200), 1)}\n\n// ... truncated. Use offset=201 to read on, or get_outline + get_symbol for specific sections.`;
		}

		return numberLines(lines, 1);
	}

	private async writeFile(filePath: string, content: string): Promise<string> {
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		// Design-agent gate: if writing a UI file, check if a design system should be suggested
		const uiExtensions = [".tsx", ".jsx", ".css", ".html", ".svelte", ".vue"];
		const ext = path.extname(absolutePath).toLowerCase();
		let designHint = "";
		if (uiExtensions.includes(ext)) {
			try {
				const isNewFile = !fs.existsSync(absolutePath);
				if (isNewFile && needsDesignDecision(`create UI file ${path.basename(absolutePath)}`)) {
					const detection = await detectDesignNeed(
						`create UI component: ${path.basename(absolutePath)}`,
					);
					if (detection.needsDesign) {
						designHint = `\n[Design Agent] This is a new UI file. Consider using suggest_design or query_design_system to ensure consistent design. Detected: ${detection.reason}`;
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

		const recordWrite = watchWrite(absolutePath, this.createdFiles);
		fs.writeFileSync(absolutePath, content);
		recordWrite();

		// Marp decks always get a narrated deck.mp4 beside them (EIGHT_DECK_VIDEO=0 opts out).
		const deckLine = await deckVideoAfterWrite(absolutePath, content, this.workingDirectory);
		if (deckLine) designHint += `\n${deckLine}`;

		// Put a finished deliverable in front of the user (#3107): only viewable
		// files, only interactively, never from a spawned sub-agent, once per
		// path per turn. Source and config files are never opened.
		const decision = decideOpenOnWrite({
			absolutePath,
			content,
			platform: process.platform,
			openOnWrite: this.openOnWrite,
			isTTY: Boolean(process.stdout.isTTY),
			env: process.env,
			openedThisTurn: this.openedThisTurn,
		});
		const opened = decision.open && openWrittenFile(absolutePath);
		if (opened) this.openedThisTurn.add(absolutePath);

		// Say "opened" only when it was.
		return `${opened ? "File written and opened" : "File written"}: ${absolutePath}${designHint}`;
	}

	private async editFile(filePath: string, oldText: string, newText: string): Promise<string> {
		// No anchor, no edit (#3101): indexOf("") is 0, so an empty oldText
		// used to prepend newText to the file.
		const noAnchor = emptyOldTextError(oldText, filePath);
		if (noAnchor) return noAnchor;
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.join(this.workingDirectory, filePath);

		if (!fs.existsSync(absolutePath)) {
			return `File not found: ${absolutePath}`;
		}

		const content = fs.readFileSync(absolutePath, "utf-8");

		// A gutter copied into newText would be written to disk as file text
		// (#3375). Refuse it, never strip it: the bytes written must be the
		// bytes the policy gate checked. Files that already hold gutter-shaped
		// lines (oldText carries one, or the file has one) are left editable.
		if (
			hasLineNumberGutter(newText) &&
			!hasLineNumberGutter(oldText) &&
			!content.split("\n").some((l) => GUTTER.test(l))
		) {
			return `Error: newText starts each line with a read_file line-number prefix (number + tab). That prefix would be written into ${filePath} as file text. Nothing was written: send newText without the prefix.`;
		}

		// Literal replacement, so the bytes written are the bytes the policy
		// gate checked (String.replace would expand `$&` etc. in newText).
		const newContent = applyEdit(content, oldText, newText);
		if (newContent === null) {
			// read_file numbers its rows (#3375). A model that copies the gutter
			// into oldText gets told so. It is never stripped silently: the
			// bytes written must be the bytes the policy gate checked.
			if (hasLineNumberGutter(oldText)) {
				return `Error: Could not find the text to replace in ${filePath}. oldText starts each line with a read_file line-number prefix (number + tab). That prefix is not in the file: send the line text only.`;
			}
			return `Error: Could not find the text to replace in ${filePath}. Make sure oldText matches exactly.`;
		}

		const recordEdit = watchWrite(absolutePath, this.createdFiles);
		fs.writeFileSync(absolutePath, newContent);
		recordEdit();

		return `File edited: ${absolutePath}\nReplaced ${oldText.length} chars with ${newText.length} chars.`;
	}

	private async listFiles(dirPath = ".", pattern?: string): Promise<string> {
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

	async runCommand(command: string, timeoutSec?: number): Promise<string> {
		if (this.permission && currentPermissionHolder() !== this.permission) {
			return runWithPermissionHolder(this.permission, () => this.runCommand(command, timeoutSec));
		}
		const mode = currentPermissionMode();
		const permissionCheck = this.permissionManager.checkPermission(command);

		if (permissionCheck === "denied") {
			return `[PERMISSION DENIED] Command blocked by security policy: ${command}`;
		}

		// Validate command for shell injection before asking anyone: a command
		// the sanitizer will refuse must not raise an approval card, or the
		// person approves it and then sees it blocked anyway (#3055).
		const validation = sanitizeShellCommand(command);
		if (!validation.safe) {
			return `[BLOCKED] ${validation.reason}. Command: ${command}`;
		}

		// System One (on by default, EIGHT_SYSTEM_ONE=0 turns it off): it can only stop a
		// command, never allow one. It runs BEFORE the approval card (#3124): a
		// System One block is final and must not follow a Y the person gave,
		// and when it escalates it asks the person itself, so that answer is
		// the card. One command, at most one card.
		// Guarded mode (#3170) turns System One on for this call whatever the
		// env says; the env flag stays on in every mode.
		const systemOne = await systemOneGate(
			command,
			systemOneEnvFor(mode),
			this.workingDirectory,
			this.createdFiles,
		);
		if (!systemOne.run) return systemOne.message as string;

		if (
			permissionCheck === "ask" &&
			systemOne.humanApproved !== true &&
			!guardedSkipsCard(mode, systemOne, isCommandDangerous(command))
		) {
			const allowed = await this.permissionManager.requestPermission(
				"Execute Shell Command",
				isCommandDangerous(command)
					? "This command may modify system files or cause data loss."
					: "The agent wants to run a shell command.",
				command,
			);

			if (!allowed) {
				return `[PERMISSION DENIED] User declined to execute: ${command}`;
			}
		}

		const startTime = Date.now();
		await this.hookManager.executeHooks("beforeCommand", {
			command,
			workingDirectory: this.workingDirectory,
		});

		let finalCommand = command;
		if (command.includes("create-next-app") && !command.includes("--yes")) {
			finalCommand = command.replace("create-next-app", "create-next-app --yes");
		}
		if (command.includes("npm init") && !command.includes("-y")) {
			finalCommand = `${command} -y`;
		}

		const timeoutMs = Math.min(timeoutSec || 120, 300) * 1000;

		return new Promise((resolve) => {
			// Redirect targets this command creates are this agent's own files (#3177).
			const recordRedirects = watchRedirects(finalCommand, this.workingDirectory, this.createdFiles);
			let resolved = false;
			const safeResolve = (value: string) => {
				if (resolved) return;
				resolved = true;
				recordRedirects();
				resolve(value);
			};

			const proc = spawnShell(finalCommand, {
				cwd: this.workingDirectory,
				stdio: ["ignore", "pipe", "pipe"],
				processGroup: true,
				env: { ...process.env, ...SPAWN_NON_INTERACTIVE_ENV },
			});

			let stdout = "";
			let stderr = "";

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			const timeout = setTimeout(() => {
				killProcessTree(proc.pid, "SIGTERM");
				setTimeout(() => killProcessTree(proc.pid, "SIGKILL"), 3000);

				this.hookManager.executeHooks("afterCommand", {
					command: finalCommand,
					exitCode: -1,
					stdout,
					stderr: `${stderr}\nTIMEOUT`,
					duration: Date.now() - startTime,
					workingDirectory: this.workingDirectory,
				});

				safeResolve(
					`TIMEOUT after ${timeoutMs / 1000}s. Partial output:\n${stdout}\n${stderr}\nTIP: Try bun instead of npx, or add --yes flag.`,
				);
			}, timeoutMs);

			proc.unref();

			proc.on("close", (code) => {
				clearTimeout(timeout);

				this.hookManager.executeHooks("afterCommand", {
					command: finalCommand,
					exitCode: code ?? 0,
					stdout,
					stderr,
					duration: Date.now() - startTime,
					workingDirectory: this.workingDirectory,
				});

				if (code === 0) {
					safeResolve(stdout || stderr || "Command completed successfully.");
				} else {
					safeResolve(`Exit code ${code}:\n${stdout}\n${stderr}`);
				}
			});

			proc.on("error", (err) => {
				clearTimeout(timeout);

				this.hookManager.executeHooks("onError", {
					command: finalCommand,
					error: err.message,
					workingDirectory: this.workingDirectory,
				});

				safeResolve(`Error: ${err.message}`);
			});
		});
	}

	/**
	 * Run a command with explicit argument array (no shell interpolation).
	 * Use for commands with LLM-provided arguments to prevent injection.
	 */
	private async runSpawn(cmd: string, args: string[]): Promise<string> {
		const { spawn } = await import("node:child_process");
		return new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			const proc = spawn(cmd, args, { cwd: this.workingDirectory });
			proc.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			proc.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
			});
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
			return JSON.stringify(
				{
					path: imageInfo.path,
					width: imageInfo.width,
					height: imageInfo.height,
					format: imageInfo.format,
					size: imageInfo.size,
					channels: imageInfo.channels,
					hasAlpha: imageInfo.hasAlpha,
					base64Length: imageInfo.base64.length,
					base64Preview: `${imageInfo.base64.slice(0, 100)}...`,
				},
				null,
				2,
			);
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
				"llava",
			);
			return JSON.stringify(
				{
					path: description.path,
					description: description.description,
					width: description.width,
					height: description.height,
					format: description.format,
					model: description.model,
				},
				null,
				2,
			);
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
			const truncatedText =
				pdfInfo.text.length > maxTextLength
					? `${pdfInfo.text.slice(0, maxTextLength)}\n\n... [truncated, ${pdfInfo.text.length - maxTextLength} more chars]`
					: pdfInfo.text;

			return JSON.stringify(
				{
					path: pdfInfo.path,
					pageCount: pdfInfo.pageCount,
					metadata: pdfInfo.metadata,
					textLength: pdfInfo.text.length,
					text: truncatedText,
				},
				null,
				2,
			);
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
			return JSON.stringify(
				{
					path: pageContent.path,
					pageNumber: pageContent.pageNumber,
					totalPages: pageContent.totalPages,
					text: pageContent.text,
				},
				null,
				2,
			);
		} catch (err) {
			return `Error reading PDF page: ${err}`;
		}
	}

	private async handleSearchPdf(
		pdfPath: string,
		query: string,
		caseSensitive?: boolean,
	): Promise<string> {
		const absolutePath = path.isAbsolute(pdfPath)
			? pdfPath
			: path.join(this.workingDirectory, pdfPath);

		try {
			const results = await searchPdf(absolutePath, query, caseSensitive ?? false);
			return JSON.stringify(
				{
					path: results.path,
					query: results.query,
					totalMatches: results.totalMatches,
					matches: results.matches.slice(0, 20),
				},
				null,
				2,
			);
		} catch (err) {
			return `Error searching PDF: ${err}`;
		}
	}

	// ============================================
	// Video Tool Handler (VIDEO-INGESTION spec §6)
	// ============================================

	/**
	 * Run the `extract_video` tool. The capability is off by default; the
	 * handler in @8gent/eyes/marlin returns a structured install-required
	 * error when the Marlin sidecar is not provisioned (spec §11).
	 */
	private async handleExtractVideo(
		videoPath: string,
		mode: ExtractVideoMode | undefined,
		query: string | undefined,
		ingest: boolean | undefined,
	): Promise<string> {
		try {
			const result = await extractVideo(
				{ path: videoPath, mode, query, ingest },
				{ cwd: this.workingDirectory },
			);
			return formatExtractVideoResult(result);
		} catch (err) {
			return `Error extracting video: ${err}`;
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
			const formattedCells = notebook.cells.map((cell) => ({
				index: cell.index,
				type: cell.type,
				executionCount: cell.executionCount,
				source:
					cell.source.length > 500 ? `${cell.source.slice(0, 500)}... [truncated]` : cell.source,
				outputCount: cell.outputs.length,
				outputs: cell.outputs.slice(0, 3).map((o) => ({
					type: o.type,
					text: o.text?.slice(0, 200),
					hasError: !!o.error,
				})),
			}));

			return JSON.stringify(
				{
					path: notebook.path,
					kernel: notebook.kernel,
					language: notebook.language,
					cellCount: notebook.cellCount,
					cells: formattedCells,
				},
				null,
				2,
			);
		} catch (err) {
			return `Error reading notebook: ${err}`;
		}
	}

	private async handleNotebookEditCell(
		notebookPath: string,
		cellIndex: number,
		newSource: string,
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
		source: string,
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

	private async handleNotebookDeleteCell(notebookPath: string, cellIndex: number): Promise<string> {
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

	// One implementation for both tool paths: packages/orchestration/delegation-tools.ts.
	private handleSpawnAgent(
		task: string,
		runtime?: "8gent" | "claude" | "shell",
		model?: string,
		timeout?: number,
		allowedPaths?: string[],
		permissionMode?: unknown,
	): Promise<string> {
		return spawnAgentTool(this.workingDirectory, task, runtime, model, timeout, allowedPaths, permissionMode);
	}

	private handleCheckAgent(agentId: string): Promise<string> {
		return checkAgentTool(agentId);
	}

	private handleListAgents(): Promise<string> {
		return listAgentsTool();
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
		args?: Record<string, unknown>,
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
		const systemOne = await systemOneGate(command, systemOneEnvFor(currentPermissionMode()));
		if (!systemOne.run) return systemOne.message as string;
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
				return JSON.stringify(
					{
						needsDesign: false,
						reason: detection.reason,
						message: "This task doesn't appear to require design decisions.",
					},
					null,
					2,
				);
			}

			// Step 2: Get design system suggestions from the design-agent
			const suggestions = await suggestDesignSystems(detection);

			// Step 3: If a project type is provided, also query the design-systems DB
			let dbSuggestions: any[] = [];
			if (projectType) {
				try {
					initDesignDb();
					dbSuggestions = suggestDesignForProject(projectType, {
						maxResults: 3,
					}).map((s) => ({
						name: s.system.system.name,
						style: s.system.system.style,
						mood: s.system.system.mood,
						score: s.score,
						reasoning: s.reasoning,
						colors: s.system.parsedColors
							? {
									primary: s.system.parsedColors.primary,
									background: s.system.parsedColors.background,
									accent: s.system.parsedColors.accent,
								}
							: null,
						tags: s.system.tags,
					}));
				} catch {
					// DB not seeded yet, skip
				}
			}

			return JSON.stringify(
				{
					needsDesign: true,
					confidence: detection.confidence,
					projectType: detection.projectType,
					categories: detection.suggestedCategories,
					frameworkSuggestions: suggestions.suggestions.map((s) => ({
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
					availableSystems: getAvailableDesignSystems().map((s) => s.name),
				},
				null,
				2,
			);
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
						return config
							? JSON.stringify(config, null, 2)
							: "No color palette available for Tailwind config.";
					}
					if (output === "hex") {
						const hex = getHexPalette(complete.system.id);
						return hex ? JSON.stringify(hex, null, 2) : "No color palette available.";
					}
					// Default: full summary
					return JSON.stringify(
						{
							name: complete.system.name,
							style: complete.system.style,
							mood: complete.system.mood,
							description: complete.system.description,
							colors: complete.parsedColors,
							typography: complete.parsedTypography,
							components: complete.components.map((c) => ({
								type: c.component_type,
								variant: c.variant,
								description: c.description,
							})),
							tags: complete.tags,
						},
						null,
						2,
					);
				}

				// Fall back to text search
				const results = searchDesignSystems_db(query);
				return JSON.stringify(
					{
						query,
						results: results.map((s) => ({
							id: s.id,
							name: s.name,
							style: s.style,
							mood: s.mood,
							description: s.description,
						})),
					},
					null,
					2,
				);
			}

			// Filter by style
			if (style) {
				const results = findDesignByStyle(style as any);
				return JSON.stringify(
					{
						style,
						results: results.map((s) => ({
							id: s.id,
							name: s.name,
							mood: s.mood,
							description: s.description,
						})),
					},
					null,
					2,
				);
			}

			// Filter by mood
			if (mood) {
				const results = findDesignByMood(mood as any);
				return JSON.stringify(
					{
						mood,
						results: results.map((s) => ({
							id: s.id,
							name: s.name,
							style: s.style,
							description: s.description,
						})),
					},
					null,
					2,
				);
			}

			// No filters — list all with available styles/moods
			const all = listAllDesignSystems();
			return JSON.stringify(
				{
					totalSystems: all.length,
					availableStyles: listDesignStyles(),
					availableMoods: listDesignMoods(),
					systems: all.map((s) => ({
						id: s.id,
						name: s.name,
						style: s.style,
						mood: s.mood,
					})),
				},
				null,
				2,
			);
		} catch (err) {
			return `Design system query failed: ${err}`;
		}
	}

	// ============================================
	// Infinite Mode
	// ============================================

	private async handleEnableInfiniteMode(
		task: string,
		maxIterations?: number,
		maxTimeMs?: number,
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
			runner
				.run()
				.then((finalState) => {
					console.log(
						`[infinite] Completed: ${finalState.phase} after ${finalState.iteration} iterations`,
					);
				})
				.catch((err) => {
					console.log(`[infinite] Fatal error: ${err}`);
				});

			return `Infinite mode ENABLED for task: "${task}"\nMax iterations: ${maxIterations ?? 100}\nMax time: ${((maxTimeMs ?? 30 * 60 * 1000) / 1000 / 60).toFixed(0)} minutes\nThe agent will now loop autonomously until the task is complete or limits are reached.`;
		} catch (err) {
			return `Failed to enable infinite mode: ${err}`;
		}
	}

	// ============================================
	// Memory Tools
	// ============================================

	private async handleRemember(
		fact: string,
		layer: "session" | "project" | "global",
	): Promise<string> {
		try {
			const memory = getMemoryManager(this.workingDirectory);
			const id = await memory.remember(fact, layer, { source: "user:remember" });
			const stats = await memory.getStats();
			return `Remembered (${layer}): "${fact.slice(0, 80)}${fact.length > 80 ? "..." : ""}"\nID: ${id}\nMemory stats: session: ${stats.session}, project: ${stats.project}, global: ${stats.global}`;
		} catch (err) {
			return `Failed to remember: ${err}`;
		}
	}

	private async handleRecall(query: string, limit?: number): Promise<string> {
		try {
			const memory = getMemoryManager(this.workingDirectory);
			const results = await memory.recall(query, limit ?? 10);

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

	private async handleDesktopClick(
		x: number,
		y: number,
		button?: string,
		count?: number,
		coordMap?: string,
	): Promise<string> {
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

	private async handleDesktopScroll(
		direction: string,
		amount?: number,
		x?: number,
		y?: number,
	): Promise<string> {
		try {
			const result = computerScroll({
				direction: direction as "up" | "down" | "left" | "right",
				amount,
				point: x !== undefined && y !== undefined ? { x, y } : undefined,
			});
			if (!result.ok) return `desktop_scroll failed: ${result.error}`;
			return `Scrolled ${direction}${amount ? ` x${amount}` : ""}`;
		} catch (err) {
			return `desktop_scroll failed: ${err}`;
		}
	}

	private async handleDesktopDrag(
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		button?: string,
		duration?: number,
	): Promise<string> {
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
			const lines = result.windows.map(
				(w, i) => `${i + 1}. [${w.app}] "${w.title}" at (${w.x},${w.y}) ${w.width}x${w.height}`,
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
			}
			const result = computerClipboardGet();
			if (!result.ok) return `desktop_clipboard failed: ${result.error}`;
			return `Clipboard contents:\n${result.text || "(empty)"}`;
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
			const lines = processes.map(
				(p, i) =>
					`${String(i + 1).padStart(2)}. ${p.name.padEnd(25)} ${String(p.memoryMB).padStart(6)} MB  ${String(p.cpu ?? 0).padStart(5)}% CPU  (PID ${p.pid})`,
			);
			return `Running processes (top ${processes.length}, sorted by ${sort || "memory"}):\n${lines.join("\n")}`;
		} catch (err) {
			return `desktop_processes failed: ${err}`;
		}
	}

	/**
	 * A desktop action the policy says needs the person (#3213). Returns null
	 * when they approved, or the refusal to hand back to the model. With no
	 * person to ask (headless, no approval card) it refuses: desktop control
	 * never runs unattended on a require_approval rule.
	 */
	private async askDesktopApproval(
		toolName: string,
		args: Record<string, unknown>,
		reason: string | undefined,
	): Promise<string | null> {
		if (this.permissionManager.isInfiniteMode()) return null;
		const request = {
			action: "Desktop control",
			details: `${reason ?? "This desktop action needs your approval."} Tool: ${toolName} ${JSON.stringify(args)}`,
		};
		let approved: boolean;
		if (hasTuiApprovalHandler()) {
			approved = (await requestTuiApproval(request)) === true;
		} else if (process.stdin.isTTY && !process.env.EIGHT_HEADLESS) {
			approved = await this.permissionManager.requestPermission(request.action, request.details);
		} else {
			return `[BLOCKED] ${toolName} needs the person's approval and there is no one to ask in this session. Nothing was done. Do not retry this call.`;
		}
		if (!approved) {
			return `[PERMISSION DENIED] The person declined ${toolName}. Nothing was done. Do not retry this call.`;
		}
		return null;
	}

	private async handleDesktopQuitApp(
		name?: string,
		pid?: number,
		strategy?: string,
	): Promise<string> {
		try {
			if (!name && !pid) return "desktop_quit_app requires either 'name' or 'pid' parameter";
			const strat = (strategy as "graceful" | "force") || "graceful";

			if (pid) {
				const result = computerQuitProcess(pid, strat);
				if (!result.ok) return `desktop_quit_app failed: ${result.error}`;
				return `Quit PID ${pid} (${strat})`;
			}
			const result = computerQuitByName(name!, strat);
			if (!result.ok) return `desktop_quit_app failed: ${result.error}`;
			return `Quit "${name}" (${strat})`;
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

			const lines = apps
				.slice(0, 15)
				.map(
					(p, i) =>
						`${String(i + 1).padStart(2)}. ${p.name.padEnd(25)} ${String(p.memoryMB).padStart(6)} MB  (PID ${p.pid})`,
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
				if (list.length === 0)
					return "Safe list is empty. Add apps with action='add' to protect them from being quit.";
				return `Safe list (${list.length} apps protected):\n${list.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
			}
			if (action === "add") {
				if (!app) return "desktop_safe_list add requires 'app' parameter";
				return computerAddToSafeList(app);
			}
			if (action === "remove") {
				if (!app) return "desktop_safe_list remove requires 'app' parameter";
				return computerRemoveFromSafeList(app);
			}
			return `Unknown safe list action: ${action}. Use 'list', 'add', or 'remove'.`;
		} catch (err) {
			return `desktop_safe_list failed: ${err}`;
		}
	}

	// ============================================
	// Browser Use Tools
	// ============================================

	private async handleBrowserOpen(
		url: string,
		browser?: string,
		session?: string,
	): Promise<string> {
		try {
			return browserOpen(url, { browser, session });
		} catch (err) {
			return `browser_open failed: ${err}`;
		}
	}

	private async handleBrowserState(session?: string): Promise<string> {
		try {
			return browserState(session);
		} catch (err) {
			return `browser_state failed: ${err}`;
		}
	}

	private async handleBrowserTask(
		task: string,
		browser?: string,
		session?: string,
	): Promise<string> {
		try {
			return browserTask(task, { browser, session });
		} catch (err) {
			return `browser_task failed: ${err}`;
		}
	}

	private async handleBrowserScreenshot(filePath?: string, session?: string): Promise<string> {
		try {
			return browserScreenshot(filePath, session);
		} catch (err) {
			return `browser_screenshot failed: ${err}`;
		}
	}

	private async handleRunComputerTask(goal: string, maxSteps?: number): Promise<string> {
		if (!goal?.trim()) return "run_computer_task: goal is required";
		const steps = Math.min(50, Math.max(1, maxSteps ?? 20));
		try {
			const { runComputerUseLoop } = await import("./loops/computer-use");
			const { ModelFailover } = await import("../providers/failover");
			const { loadVisionConfig } = await import("./vision-router");
			const { existsSync } = await import("node:fs");
			const { homedir } = await import("node:os");
			const { join } = await import("node:path");
			const { executeHandsTool } = await import("../daemon/tools/hands");

			const visionCfg = loadVisionConfig();
			const { resolveComputerUseModel } = await import("./vision-router");
			const { model: pinnedModel, autoSelected } = await resolveComputerUseModel(
				visionCfg.computerUseModel,
				{ openRouterApiKey: process.env.OPENROUTER_API_KEY },
			);
			if (autoSelected) {
				console.log(
					`[cua] auto-selected vision model: ${pinnedModel} (${visionCfg.computerUseModel} is not vision-capable)`,
				);
			}
			const failover = new ModelFailover();

			// Skip providers that lack credentials or aren't installed.
			if (!process.env.DEEPSEEK_API_KEY) failover.markDown("deepseek-flash", "deepseek");
			if (!process.env.OPENROUTER_API_KEY)
				failover.markDown("meta-llama/llama-3-8b-instruct:free", "openrouter");
			if (!existsSync(join(homedir(), ".8gent", "bin", "apple-foundation-bridge"))) {
				failover.markDown("apple-foundationmodel", "apfel");
			}

			// Instant AX tree placeholder — lets the model ask for desktop_windows itself.
			const handsAdapter: import("./loops/computer-use").HandsAdapter = async (
				toolName,
				args,
				ctx,
			) => {
				if (toolName === "desktop_accessibility_tree") {
					return {
						ok: true as const,
						result: {
							pid: 0,
							appName: "desktop",
							windowTitle: "AX tree unavailable - call desktop_windows to list open windows",
							root: {
								role: "AXDesktop",
								title: "Call desktop_windows to enumerate open windows.",
								children: [],
							},
						},
					};
				}
				const r = await executeHandsTool(toolName, args, ctx);
				if (r.ok) return { ok: true as const, result: r.result };
				return { ok: false as const, reason: (r as any).error ?? "hands error" };
			};

			// Agent callers can't answer interactive y/N prompts.
			// Auto-approve all desktop actions except quitting apps.
			const agentApprove: import("../daemon/tools/hands").HandsToolCtx["approve"] = async ({
				tool,
			}) => tool !== "desktop_quit_app";

			const result = await runComputerUseLoop({
				goal: goal.trim(),
				maxSteps: steps,
				sessionId: `tools-cua-${Date.now()}`,
				pinnedModel,
				failover,
				handsAdapter,
				approve: agentApprove,
			});

			const summary = [
				`outcome: ${result.reason}`,
				`steps: ${result.steps.length}/${steps}`,
				result.finalMessage ?? "",
			]
				.filter(Boolean)
				.join("\n");
			return result.ok
				? `Computer task complete.\n${summary}`
				: `Computer task failed.\n${summary}`;
		} catch (err) {
			return `run_computer_task error: ${err instanceof Error ? err.message : String(err)}`;
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
