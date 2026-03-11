/**
 * 8gent Code - Agent Core
 *
 * The brain that connects local LLMs to the toolshed.
 * This is what makes 8gent equivalent to Claude Code.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { getToolRegistry } from "../toolshed/registry";
import { parseTypeScriptFile, getSymbolSource } from "../ast-index/typescript-parser";

// Security & Workflow
import {
  getPermissionManager,
  requestCommandPermission,
  isCommandDangerous,
  type PermissionManager,
} from "../permissions";
import {
  getHookManager,
  executeHooks,
  type HookManager,
  type HookContext,
} from "../hooks";

// Orchestration features
import {
  getSkillManager,
  parseSkillCommand,
  type SkillManager,
  type Skill,
} from "../skills";
import {
  getAgentPool,
  getTaskQueue,
  parseSpawnCommand,
  formatAgentStatus,
  type AgentPool,
  type SpawnedAgent,
} from "../orchestration";
import {
  getTaskManager,
  parseTaskCommand,
  formatTask,
  type TaskManager,
  type Task,
} from "../tasks";

// Multimodal tools
import {
  readImage,
  describeImage,
  getImageMetadata,
} from "../tools/image";
// PDF tools - lazy loaded to avoid DOMMatrix issues
// import { readPdf, readPdfPage, getPdfMetadata } from "../tools/pdf";
const readPdf = async (p: string) => { throw new Error("PDF support coming soon"); };
const readPdfPage = async (p: string, n: number) => { throw new Error("PDF support coming soon"); };
const getPdfMetadata = async (p: string) => { throw new Error("PDF support coming soon"); };
import {
  readNotebook,
  getCell,
  editCell,
  insertCell,
  deleteCell,
  getNotebookSummary,
} from "../tools/notebook";

// MCP, Web, and Background tools
import {
  getMCPClient,
  formatToolResult,
  type MCPToolResult,
} from "../mcp";

// LSP integration
import {
  lspGoToDefinition,
  lspFindReferences,
  lspHover,
  lspDocumentSymbols,
  getLSPManager,
} from "../lsp";
import {
  webSearch,
  webFetch,
  formatSearchResults,
  formatFetchResult,
} from "../tools/web";
import {
  getBackgroundTaskManager,
  formatTaskStatus,
  formatTaskOutput,
  type TaskInfo,
} from "../tools/background";

// Reporting
import {
  AgentReportingContext,
  createReportingContext,
  handleReportCommands,
  extractCommitHash,
  extractBranchName,
  generateCompletionMarker,
  getCompletionReporter,
} from "../reporting";

// ============================================
// Types
// ============================================

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface AgentConfig {
  model: string;
  runtime: "ollama";
  systemPrompt?: string;
  maxTurns?: number;
  workingDirectory?: string;
}

interface OllamaResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: {
      function: {
        name: string;
        arguments: string;
      };
    }[];
  };
  done: boolean;
}

// ============================================
// System Prompt
// ============================================

const DEFAULT_SYSTEM_PROMPT = `You are 8gent, an AUTONOMOUS AI coding agent powered by the BMAD Method.

## BMAD METHOD (Breakthrough Method of Agile AI-driven Development)

Before executing ANY task, follow this process:

### Step 1: CLASSIFY (think first)
- Trivial (1-2 files): Execute directly
- Small (2-5 files): Quick plan, then execute
- Medium (5-10 files): Write plan, execute step by step
- Large (10+ files): Full breakdown into stories

### Step 2: PLAN (output your plan)
Write a brief plan as your FIRST response:
"PLAN: 1) scaffold project 2) create landing page 3) create about page 4) add theme toggle 5) git commit"

### Step 3: EXECUTE (one step at a time)
- Complete ONE step fully before moving to next
- VERIFY each step worked (list_files, read_file)
- If step fails, try alternative approach ONCE, then move on

### Step 4: COMMIT (git after each major step)
- git_add + git_commit after completing each feature

## CRITICAL BEHAVIOR RULES
1. ALWAYS output a PLAN first for multi-step tasks
2. NEVER give instructions or tutorials. USE TOOLS to do the work yourself.
3. NEVER show code blocks to the user. WRITE files directly with write_file.
4. NEVER ask "would you like me to..." - just DO IT.
5. You can execute MULTIPLE tools in PARALLEL when they are independent.
6. If a tool fails twice, SKIP IT and continue with next step.

WRONG: "Here's the code..." or "You can create..."
RIGHT: "PLAN: 1) create app 2) add pages 3) commit" then {"tool": "run_command", ...}

## Tool Format

Output JSON to use tools. You can call MULTIPLE tools at once for parallel execution:

Single tool:
\`\`\`json
{"tool": "TOOL_NAME", "arguments": {"key": "value"}}
\`\`\`

Multiple tools (executed in parallel):
\`\`\`json
{"tool": "read_file", "arguments": {"path": "a.ts"}}
{"tool": "read_file", "arguments": {"path": "b.ts"}}
\`\`\`

## Code Exploration (AST-first for efficiency)
- get_outline: List functions/classes in file
  {"tool": "get_outline", "arguments": {"filePath": "src/index.ts"}}
- get_symbol: Get one function's source
  {"tool": "get_symbol", "arguments": {"symbolId": "src/index.ts::myFunc"}}
- search_symbols: Find symbols by name
  {"tool": "search_symbols", "arguments": {"query": "handleError"}}

## LSP Tools (Language Server Protocol)
- lsp_goto_definition: Jump to where a symbol is defined
  {"tool": "lsp_goto_definition", "arguments": {"filePath": "src/index.ts", "line": 10, "character": 15}}
- lsp_find_references: Find all usages of a symbol
  {"tool": "lsp_find_references", "arguments": {"filePath": "src/index.ts", "line": 10, "character": 15}}
- lsp_hover: Get type info and documentation for a symbol
  {"tool": "lsp_hover", "arguments": {"filePath": "src/index.ts", "line": 10, "character": 15}}
- lsp_document_symbols: Get all symbols in a file (via LSP)
  {"tool": "lsp_document_symbols", "arguments": {"filePath": "src/index.ts"}}

## File Operations
- read_file: Read file contents
  {"tool": "read_file", "arguments": {"path": "package.json"}}
- write_file: Write/create file
  {"tool": "write_file", "arguments": {"path": "new.ts", "content": "..."}}
- edit_file: Replace text in file (surgical edit)
  {"tool": "edit_file", "arguments": {"path": "src/index.ts", "oldText": "foo", "newText": "bar"}}
- list_files: List files
  {"tool": "list_files", "arguments": {"path": ".", "pattern": "**/*.ts"}}

## Git Operations
- git_status: Show working tree status
  {"tool": "git_status", "arguments": {}}
- git_diff: Show changes
  {"tool": "git_diff", "arguments": {"staged": false}}
- git_log: Show recent commits
  {"tool": "git_log", "arguments": {"count": 10}}
- git_branch: List branches
  {"tool": "git_branch", "arguments": {}}
- git_checkout: Switch branch
  {"tool": "git_checkout", "arguments": {"branch": "main"}}
- git_create_branch: Create new branch
  {"tool": "git_create_branch", "arguments": {"branch": "feature/foo"}}
- git_add: Stage files
  {"tool": "git_add", "arguments": {"files": "."}}
- git_commit: Commit staged changes
  {"tool": "git_commit", "arguments": {"message": "feat: add feature"}}
- git_push: Push to remote
  {"tool": "git_push", "arguments": {"setUpstream": true}}

## GitHub CLI (gh)
- gh_pr_list: List pull requests
  {"tool": "gh_pr_list", "arguments": {}}
- gh_pr_create: Create pull request
  {"tool": "gh_pr_create", "arguments": {"title": "Add feature", "body": "Description"}}
- gh_pr_view: View PR details
  {"tool": "gh_pr_view", "arguments": {"number": 123}}
- gh_issue_list: List issues
  {"tool": "gh_issue_list", "arguments": {}}
- gh_issue_create: Create issue
  {"tool": "gh_issue_create", "arguments": {"title": "Bug", "body": "Details"}}

## Shell
- run_command: Run any shell command
  {"tool": "run_command", "arguments": {"command": "npm test"}}

## Image Tools (Multimodal)
- read_image: Read image file, returns base64 + dimensions
  {"tool": "read_image", "arguments": {"path": "screenshot.png"}}
- describe_image: Describe image using vision model (llava)
  {"tool": "describe_image", "arguments": {"path": "diagram.png", "prompt": "What does this show?"}}

## PDF Tools
- read_pdf: Extract all text from PDF
  {"tool": "read_pdf", "arguments": {"path": "document.pdf"}}
- read_pdf_page: Extract text from specific page
  {"tool": "read_pdf_page", "arguments": {"path": "document.pdf", "pageNum": 1}}

## Jupyter Notebook Tools
- read_notebook: Read notebook, returns all cells with outputs
  {"tool": "read_notebook", "arguments": {"path": "analysis.ipynb"}}
- notebook_edit_cell: Edit a cell's source code
  {"tool": "notebook_edit_cell", "arguments": {"path": "analysis.ipynb", "cellIndex": 0, "newSource": "print('hello')"}}
- notebook_insert_cell: Insert new cell after index
  {"tool": "notebook_insert_cell", "arguments": {"path": "analysis.ipynb", "afterIndex": 0, "cellType": "code", "source": "x = 1"}}
- notebook_delete_cell: Delete a cell
  {"tool": "notebook_delete_cell", "arguments": {"path": "analysis.ipynb", "cellIndex": 2}}

## Web Tools
- web_search: Search the web using DuckDuckGo (no API key needed)
  {"tool": "web_search", "arguments": {"query": "react hooks tutorial", "maxResults": 5}}
- web_fetch: Fetch and extract content from a URL
  {"tool": "web_fetch", "arguments": {"url": "https://example.com/docs"}}

## MCP (Model Context Protocol) Tools
- mcp_list_tools: List all available MCP tools from connected servers
  {"tool": "mcp_list_tools", "arguments": {}}
- mcp_call_tool: Call an MCP tool on a specific server
  {"tool": "mcp_call_tool", "arguments": {"server": "filesystem", "tool": "read_file", "args": {"path": "/tmp/test.txt"}}}

## Background Tasks
- background_start: Start a command in the background
  {"tool": "background_start", "arguments": {"command": "npm run build"}}
- background_status: Check the status of a background task
  {"tool": "background_status", "arguments": {"taskId": "task_123"}}
- background_output: Get the output of a background task
  {"tool": "background_output", "arguments": {"taskId": "task_123"}}

## Error Recovery (CRITICAL)
If a command fails or times out:
1. NEVER retry the exact same command
2. Try an alternative approach:
   - npx hangs? Use "bun create" or "npm init" instead
   - create-next-app fails? Use "bun create next-app . --yes" (non-interactive)
   - npm install hangs? Use "bun install" instead
   - Interactive prompts? Add --yes, -y, or --no-input flags
3. If a tool errors 2x, try a completely different strategy
4. You can manually create files instead of using scaffolding tools

## Rules (BMAD Workflow)
1. PLAN FIRST. Output "PLAN: 1) ... 2) ... 3) ..." before any tool use.
2. PARALLEL WHEN POSSIBLE. Read multiple files at once, run independent ops together.
3. VERIFY SUCCESS. Use list_files or read_file after creating files.
4. FAIL FAST. If step fails twice, skip and continue.
5. COMMIT OFTEN. git_add + git_commit after each feature.
6. Prefer bun over npm/npx for speed.
7. NEVER output code blocks. Use write_file tool.
8. Use get_outline before reading full files (saves tokens).

## Example Parallel Tool Use
User: "What's in a.ts and b.ts?"
You respond with both tool calls at once:
{"tool": "read_file", "arguments": {"path": "a.ts"}}
{"tool": "read_file", "arguments": {"path": "b.ts"}}

## Example BMAD Workflow
User: "Build a Next.js site with landing and about pages"
You respond:
"PLAN: 1) scaffold Next.js 2) create landing page 3) create about page 4) git init and commit"
Then immediately:
{"tool": "run_command", "arguments": {"command": "bun create next-app . --yes"}}`;

// ============================================
// Ollama Client
// ============================================

class OllamaClient {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl: string = "http://localhost:11434") {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  async chat(messages: Message[], tools?: object[]): Promise<OllamaResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    return response.json();
  }

  async generate(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.response;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ============================================
// Tool Executor
// ============================================

class ToolExecutor {
  private workingDirectory: string;
  private permissionManager: PermissionManager;
  private hookManager: HookManager;

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
    this.permissionManager = getPermissionManager();
    this.hookManager = getHookManager();
    this.hookManager.setWorkingDirectory(workingDirectory);
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      // Code exploration
      case "get_outline":
        return this.getOutline(args.filePath as string);
      case "get_symbol":
        return this.getSymbol(args.symbolId as string);
      case "search_symbols":
        return this.searchSymbols(args.query as string, args.kinds as string[]);

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

      // File operations
      case "read_file":
        return this.readFile(args.path as string);
      case "write_file":
        return this.writeFile(args.path as string, args.content as string);
      case "edit_file":
        return this.editFile(args.path as string, args.oldText as string, args.newText as string);
      case "list_files":
        return this.listFiles(args.path as string, args.pattern as string);

      // Git operations
      case "git_status":
        return this.runCommand("git status");
      case "git_diff":
        return this.runCommand(args.staged ? "git diff --staged" : "git diff");
      case "git_log":
        return this.runCommand(`git log --oneline -${args.count || 10}`);
      case "git_branch":
        return this.runCommand("git branch -a");
      case "git_checkout":
        return this.runCommand(`git checkout ${args.branch}`);
      case "git_create_branch":
        return this.runCommand(`git checkout -b ${args.branch}`);
      case "git_add":
        return this.runCommand(`git add ${args.files || "."}`);
      case "git_commit":
        return this.runCommand(`git commit -m "${args.message}"`);
      case "git_push":
        return this.runCommand(`git push ${args.setUpstream ? "-u origin HEAD" : ""}`);

      // GitHub CLI
      case "gh_pr_list":
        return this.runCommand("gh pr list");
      case "gh_pr_create":
        return this.runCommand(`gh pr create --title "${args.title}" --body "${args.body || ""}"`);
      case "gh_pr_view":
        return this.runCommand(`gh pr view ${args.number || ""}`);
      case "gh_issue_list":
        return this.runCommand("gh issue list");
      case "gh_issue_create":
        return this.runCommand(`gh issue create --title "${args.title}" --body "${args.body || ""}"`);

      // Shell
      case "run_command":
        return this.runCommand(args.command as string);

      // Image tools (multimodal)
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

      default:
        return `Unknown tool: ${toolName}`;
    }
  }

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

  private async readFile(filePath: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDirectory, filePath);

    if (!fs.existsSync(absolutePath)) {
      return `File not found: ${absolutePath}`;
    }

    const content = fs.readFileSync(absolutePath, "utf-8");
    const lines = content.split("\n");

    if (lines.length > 200) {
      return `// File has ${lines.length} lines. Showing first 200:\n\n${lines.slice(0, 200).join("\n")}\n\n// ... truncated. Use get_outline + get_symbol for specific sections.`;
    }

    return content;
  }

  private async writeFile(filePath: string, content: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workingDirectory, filePath);

    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(absolutePath, content);
    return `File written: ${absolutePath}`;
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

  private async runCommand(command: string): Promise<string> {
    const { spawn } = await import("child_process");

    // Check permissions before executing
    const permissionCheck = this.permissionManager.checkPermission(command);

    if (permissionCheck === "denied") {
      return `[PERMISSION DENIED] Command blocked by security policy: ${command}`;
    }

    if (permissionCheck === "ask") {
      // Request permission from user
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

    // Execute beforeCommand hooks
    const startTime = Date.now();
    await this.hookManager.executeHooks("beforeCommand", {
      command,
      workingDirectory: this.workingDirectory,
    });

    // Auto-add --yes flags for known interactive commands
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

      // Auto-answer interactive prompts with defaults (Enter key)
      const stdinInterval = setInterval(() => {
        try { proc.stdin.write('\n'); } catch {}
      }, 1000);

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      const timeout = setTimeout(() => {
        clearInterval(stdinInterval);
        proc.kill('SIGTERM');

        // Execute afterCommand hooks with timeout info
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
        clearInterval(stdinInterval);

        // Execute afterCommand hooks
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
        clearInterval(stdinInterval);

        // Execute onError hooks
        this.hookManager.executeHooks("onError", {
          command: finalCommand,
          error: err.message,
          workingDirectory: this.workingDirectory,
        });

        resolve(`Error: ${err.message}`);
      });
    });
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
}

// ============================================
// Agent
// ============================================

export class Agent {
  private client: OllamaClient;
  private executor: ToolExecutor;
  private messages: Message[] = [];
  private config: AgentConfig;
  private hookManager: HookManager;
  private sessionId: string;
  private sessionStartTime: number;
  private reportingContext: AgentReportingContext | null = null;
  private enableReporting: boolean = true;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new OllamaClient(config.model);
    this.executor = new ToolExecutor(config.workingDirectory || process.cwd());
    this.hookManager = getHookManager();
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.sessionStartTime = Date.now();

    // Set working directory for hooks
    this.hookManager.setWorkingDirectory(config.workingDirectory || process.cwd());

    // Initialize with system prompt
    this.messages.push({
      role: "system",
      content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    });

    // Execute onStart hooks
    this.hookManager.executeHooks("onStart", {
      sessionId: this.sessionId,
      workingDirectory: config.workingDirectory || process.cwd(),
    });
  }

  async chat(userMessage: string): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });

    // Initialize reporting context for this task
    if (this.enableReporting) {
      this.reportingContext = createReportingContext(
        userMessage,
        this.config.workingDirectory || process.cwd(),
        this.config.model
      );
    }

    let turns = 0;
    const maxTurns = this.config.maxTurns || 20; // Increased for complex scaffolding tasks
    const chatStartTime = Date.now();

    while (turns < maxTurns) {
      turns++;

      // Get response from model
      const response = await this.client.chat(this.messages);
      const content = response.message.content;

      // Check for tool calls in the response (supports multiple parallel calls)
      const toolCalls = this.parseToolCalls(content);

      if (toolCalls.length > 0) {
        // Execute tools in parallel
        console.log(`\n[Executing ${toolCalls.length} tool(s)${toolCalls.length > 1 ? ' in parallel' : ''}]`);

        const results = await Promise.all(
          toolCalls.map(async (toolCall) => {
            // Execute beforeTool hooks
            await this.hookManager.executeHooks("beforeTool", {
              sessionId: this.sessionId,
              tool: toolCall.name,
              toolInput: toolCall.arguments,
              workingDirectory: this.config.workingDirectory || process.cwd(),
            });

            console.log(`  -> ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 50)}...)`);
            const toolStartTime = Date.now();
            let result: string;
            let toolError: string | undefined;

            // Record tool start for reporting
            if (this.reportingContext) {
              this.reportingContext.recordToolStart(toolCall.name, toolCall.arguments);
            }

            try {
              result = await this.executor.execute(toolCall.name, toolCall.arguments);
            } catch (err) {
              toolError = err instanceof Error ? err.message : String(err);
              result = `Error: ${toolError}`;

              // Execute onError hooks
              await this.hookManager.executeHooks("onError", {
                sessionId: this.sessionId,
                tool: toolCall.name,
                toolInput: toolCall.arguments,
                error: toolError,
                errorStack: err instanceof Error ? err.stack : undefined,
                workingDirectory: this.config.workingDirectory || process.cwd(),
              });
            }

            // Record tool end for reporting
            if (this.reportingContext) {
              this.reportingContext.recordToolEnd(
                toolCall.name,
                toolCall.arguments,
                result,
                toolStartTime,
                !toolError
              );

              // Track git operations
              if (toolCall.name === "git_commit" && result.includes("[")) {
                const commitHash = extractCommitHash(result);
                if (commitHash) {
                  this.reportingContext.addGitCommit(commitHash);
                }
              }
              if (toolCall.name === "git_status" || toolCall.name === "git_branch") {
                const branch = extractBranchName(result);
                if (branch) {
                  this.reportingContext.setGitBranch(branch);
                }
              }
            }

            // Execute afterTool hooks
            await this.hookManager.executeHooks("afterTool", {
              sessionId: this.sessionId,
              tool: toolCall.name,
              toolInput: toolCall.arguments,
              toolOutput: result,
              duration: Date.now() - toolStartTime,
              error: toolError,
              workingDirectory: this.config.workingDirectory || process.cwd(),
            });

            return { name: toolCall.name, result };
          })
        );

        // Add assistant message with tool calls
        this.messages.push({ role: "assistant", content });

        // Aggregate results into a single message
        const aggregatedResults = results
          .map((r, i) => `[Tool ${i + 1} Result for ${r.name}]:\n${r.result}`)
          .join("\n\n");

        // Add tool results as a user message
        this.messages.push({
          role: "user",
          content: `${aggregatedResults}\n\nNow respond to the user based on these results. Do NOT call the same tools again.`,
        });

        // Continue loop to process tool results
        continue;
      } else {
        // No tool call, return the response
        this.messages.push({ role: "assistant", content });

        // Generate completion report
        let finalContent = content;
        if (this.reportingContext && this.enableReporting) {
          this.reportingContext.setResult(content);
          const report = this.reportingContext.complete({ display: true, save: true });

          // Add completion marker for voice hook
          const completionMarker = generateCompletionMarker(report);
          finalContent = content + completionMarker;
        }

        // Execute onComplete hooks
        await this.hookManager.executeHooks("onComplete", {
          sessionId: this.sessionId,
          result: finalContent,
          duration: Date.now() - chatStartTime,
          tokenCount: content.length, // Approximate
          workingDirectory: this.config.workingDirectory || process.cwd(),
        });

        return content;
      }
    }

    // Generate completion report for max turns
    if (this.reportingContext && this.enableReporting) {
      this.reportingContext.setError("Max turns reached");
      this.reportingContext.complete({ display: true, save: true });
    }

    // Execute onComplete hooks for max turns
    await this.hookManager.executeHooks("onComplete", {
      sessionId: this.sessionId,
      result: "Max turns reached",
      duration: Date.now() - chatStartTime,
      workingDirectory: this.config.workingDirectory || process.cwd(),
    });

    return "Max turns reached. Please try a simpler request.";
  }

  /**
   * Parse multiple tool calls from content.
   * Supports both single tool and multiple parallel tools.
   */
  private parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];

    // Strategy 1: Look for multiple JSON objects (parallel format)
    // Pattern: multiple {"tool": "...", "arguments": {...}} on separate lines or inline
    const jsonLinePattern = /\{"tool"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
    let match;

    while ((match = jsonLinePattern.exec(content)) !== null) {
      try {
        const args = JSON.parse(match[2]);
        toolCalls.push({
          id: `${Date.now()}-${toolCalls.length}`,
          name: match[1],
          arguments: args,
        });
      } catch {
        // Skip malformed JSON
      }
    }

    // If we found any via simple pattern, return them
    if (toolCalls.length > 0) {
      return toolCalls;
    }

    // Strategy 2: Look for code fence with JSON
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      // Try parsing as array first
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.tool) {
              toolCalls.push({
                id: `${Date.now()}-${toolCalls.length}`,
                name: item.tool,
                arguments: item.arguments || {},
              });
            }
          }
          return toolCalls;
        }
        if (parsed.tool) {
          return [{
            id: Date.now().toString(),
            name: parsed.tool,
            arguments: parsed.arguments || {},
          }];
        }
      } catch {
        // Try line by line within the fence
        const lines = jsonMatch[1].split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.tool) {
              toolCalls.push({
                id: `${Date.now()}-${toolCalls.length}`,
                name: parsed.tool,
                arguments: parsed.arguments || {},
              });
            }
          } catch {
            // Skip non-JSON lines
          }
        }
        if (toolCalls.length > 0) {
          return toolCalls;
        }
      }
    }

    // Strategy 3: Extract tool name and arguments for write_file with complex content
    const toolMatch = content.match(/"tool"\s*:\s*"(\w+)"/);
    if (toolMatch && toolMatch[1]) {
      const toolName = toolMatch[1];
      let args: Record<string, unknown> = {};

      // Special handling for write_file with multiline content
      if (toolName === "write_file") {
        const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/);
        const contentMatch = content.match(/"content"\s*:\s*[`"]([\s\S]*?)[`"]\s*\}/);
        if (pathMatch) {
          args = {
            path: pathMatch[1],
            content: contentMatch ? contentMatch[1] : "",
          };
        }
      } else {
        const argsMatch = content.match(/"arguments"\s*:\s*\{([^]*?)\}\s*\}/);
        if (argsMatch) {
          try {
            args = JSON.parse(`{${argsMatch[1]}}`);
          } catch {
            // Try individual args extraction
            const commandMatch = content.match(/"command"\s*:\s*"([^"]+)"/);
            if (commandMatch) args = { command: commandMatch[1] };

            const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/);
            if (pathMatch) args = { ...args, path: pathMatch[1] };

            const filePathMatch = content.match(/"filePath"\s*:\s*"([^"]+)"/);
            if (filePathMatch) args = { ...args, filePath: filePathMatch[1] };

            const lineMatch = content.match(/"line"\s*:\s*(\d+)/);
            if (lineMatch) args = { ...args, line: parseInt(lineMatch[1], 10) };

            const charMatch = content.match(/"character"\s*:\s*(\d+)/);
            if (charMatch) args = { ...args, character: parseInt(charMatch[1], 10) };
          }
        }
      }

      return [{
        id: Date.now().toString(),
        name: toolName,
        arguments: args,
      }];
    }

    return [];
  }

  async isReady(): Promise<boolean> {
    return this.client.isAvailable();
  }

  clearHistory(): void {
    this.messages = [this.messages[0]]; // Keep system prompt
  }

  getModel(): string {
    return this.config.model;
  }

  setModel(model: string): void {
    this.config.model = model;
    this.client = new OllamaClient(model);
  }

  getHistoryLength(): number {
    return this.messages.length;
  }

  getWorkingDirectory(): string {
    return this.executor["workingDirectory"];
  }

  setReportingEnabled(enabled: boolean): void {
    this.enableReporting = enabled;
  }

  isReportingEnabled(): boolean {
    return this.enableReporting;
  }

  getLastReport() {
    if (this.reportingContext) {
      const reporter = getCompletionReporter();
      const context = this.reportingContext.getContext();
      return reporter.generateReport(context);
    }
    return null;
  }

  /**
   * Cleanup LSP clients on shutdown
   */
  async cleanup(): Promise<void> {
    const manager = getLSPManager();
    await manager.stopAll();
  }
}

// ============================================
// CLI REPL
// ============================================

export async function startREPL(config?: Partial<AgentConfig>) {
  // Load config from file
  const configPath = path.join(os.homedir(), ".8gent", "config.json");
  let savedConfig: Partial<AgentConfig> = {};

  if (fs.existsSync(configPath)) {
    savedConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  const finalConfig: AgentConfig = {
    model: config?.model || savedConfig.model || "glm-4.7-flash:latest",
    runtime: "ollama",
    workingDirectory: config?.workingDirectory || process.cwd(),
    ...config,
  };

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║   █████╗  ██████╗ ███████╗███╗   ██╗████████╗             ║
║  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝             ║
║  ╚█████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║                ║
║  ██╔══██╗██║   ██║██╔══╝  ██║╚██╗██║   ██║                ║
║  ╚█████╔╝╚██████╔╝███████╗██║ ╚████║   ██║                ║
║   ╚════╝  ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   CODE         ║
╚═══════════════════════════════════════════════════════════╝

Model: ${finalConfig.model}
Working directory: ${finalConfig.workingDirectory}

Type your request, or:
  /help     - Show commands
  /clear    - Clear history
  /quit     - Exit
`);

  const agent = new Agent(finalConfig);

  // Check if Ollama is running
  if (!(await agent.isReady())) {
    console.log("⚠️  Ollama is not running. Start it with: ollama serve");
    console.log("   Then run: npx 8gent-code");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question("\n\x1b[36m❯\x1b[0m ", async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "/q") {
        console.log("Goodbye!");
        rl.close();
        process.exit(0);
      }

      if (trimmed === "/clear") {
        agent.clearHistory();
        console.log("History cleared.");
        prompt();
        return;
      }

      if (trimmed === "/help") {
        console.log(`
\x1b[36m8gent Commands:\x1b[0m

\x1b[33mBasic:\x1b[0m
  /help       - Show this help
  /clear      - Clear conversation history
  /quit       - Exit 8gent

\x1b[33mModel:\x1b[0m
  /model              - Show current model
  /model <name>       - Switch model (e.g., /model qwen3:14b)
  /models             - List available Ollama models

\x1b[33mBMAD Planning:\x1b[0m
  /plan <task>        - Create a plan without executing
  /status             - Show current task status

\x1b[33mPermissions:\x1b[0m
  /permissions        - Show permission config
  /allow <pattern>    - Allow commands matching pattern
  /deny <pattern>     - Deny commands matching pattern
  /auto-approve       - Toggle auto-approve mode

\x1b[33mHooks:\x1b[0m
  /hooks              - List all hooks
  /hooks enable <id>  - Enable a hook
  /hooks disable <id> - Disable a hook

\x1b[33mSkills:\x1b[0m
  /skills             - List available skills
  /<skill> [args]     - Invoke a skill (e.g., /commit "feat: add feature")

\x1b[33mMulti-Agent:\x1b[0m
  /spawn <task>       - Spawn background agent for task
  /agents             - List running agents
  /agent <id>         - Get status and evidence for specific agent
  /join <id>          - Wait for agent to complete
  /kill <id>          - Terminate an agent
  /evidence           - Show all collected evidence for current task

\x1b[33mTasks:\x1b[0m
  /task "desc"        - Create a new task
  /tasks              - List all tasks
  /task:done <id>     - Mark task complete
  /task:start <id>    - Start working on task

\x1b[33mMCP (Model Context Protocol):\x1b[0m
  /mcp                - Show MCP server status
  /mcp-tools          - List available MCP tools

\x1b[33mBackground Tasks:\x1b[0m
  /bg                 - List background tasks
  /bg <id>            - Show task details

\x1b[33mLSP (Language Server Protocol):\x1b[0m
  /lsp                - Show LSP status and supported languages

\x1b[33mCompletion Reports:\x1b[0m
  /reports            - List recent completion reports
  /reports --stats    - Show report statistics
  /report <id>        - View a specific report
  /reporting          - Toggle completion reports on/off

\x1b[33mTips:\x1b[0m
  - Ask to explore code: "What functions are in src/index.ts?"
  - Ask to build something: "Build a React component for..."
  - Ask to fix code: "Fix the bug in the login function"
  - Web search: "Search for React hooks best practices"
`);
        prompt();
        return;
      }

      if (trimmed === "/model") {
        console.log(`Current model: \x1b[36m${agent.getModel()}\x1b[0m`);
        prompt();
        return;
      }

      if (trimmed.startsWith("/model ")) {
        const newModel = trimmed.slice(7).trim();
        agent.setModel(newModel);
        console.log(`Switched to model: \x1b[36m${newModel}\x1b[0m`);
        prompt();
        return;
      }

      if (trimmed === "/models") {
        try {
          const response = await fetch("http://localhost:11434/api/tags");
          const data = await response.json();
          console.log("\x1b[36mAvailable models:\x1b[0m");
          for (const model of data.models || []) {
            console.log(`  - ${model.name} (${(model.size / 1e9).toFixed(1)}GB)`);
          }
        } catch {
          console.log("Could not fetch models. Is Ollama running?");
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/plan ")) {
        const task = trimmed.slice(6).trim();
        console.log(`\n\x1b[33mCreating plan for:\x1b[0m ${task}\n`);
        const planPrompt = `Create a PLAN ONLY (do not execute) for: ${task}\nOutput format: PLAN: 1) ... 2) ... 3) ...`;
        try {
          const response = await agent.chat(planPrompt);
          console.log(`\n\x1b[32m${response}\x1b[0m`);
        } catch (err) {
          console.error(`\x1b[31mError: ${err}\x1b[0m`);
        }
        prompt();
        return;
      }

      if (trimmed === "/status") {
        console.log(`\n\x1b[36m8gent Status:\x1b[0m`);
        console.log(`  Model: ${agent.getModel()}`);
        console.log(`  Working Dir: ${process.cwd()}`);
        console.log(`  History: ${agent.getHistoryLength()} messages`);
        prompt();
        return;
      }

      // MCP commands
      if (trimmed === "/mcp") {
        const mcpClient = getMCPClient();
        const servers = mcpClient.getRunningServers();
        if (servers.length === 0) {
          console.log("\x1b[33mNo MCP servers running.\x1b[0m Configure in ~/.8gent/mcp.json");
        } else {
          console.log("\x1b[36mMCP Servers:\x1b[0m");
          for (const server of servers) {
            const tools = mcpClient.getServerTools(server);
            console.log(`  - ${server}: ${tools.length} tools`);
          }
        }
        prompt();
        return;
      }

      if (trimmed === "/mcp-tools") {
        const mcpClient = getMCPClient();
        const tools = mcpClient.listTools();
        if (tools.length === 0) {
          console.log("\x1b[33mNo MCP tools available.\x1b[0m");
        } else {
          console.log("\x1b[36mMCP Tools:\x1b[0m");
          for (const { server, tool } of tools) {
            console.log(`  [\x1b[33m${server}\x1b[0m] ${tool.name}: ${tool.description || "No description"}`);
          }
        }
        prompt();
        return;
      }

      // LSP commands
      if (trimmed === "/lsp") {
        console.log(`
\x1b[36mLSP Status:\x1b[0m
  Supported languages: typescript, python, rust
  Required servers:
    - typescript: typescript-language-server (npm install -g typescript-language-server typescript)
    - python: pyright (pip install pyright)
    - rust: rust-analyzer (rustup component add rust-analyzer)

  LSP Tools:
    - lsp_goto_definition: Jump to symbol definition
    - lsp_find_references: Find all usages
    - lsp_hover: Get type info and docs
    - lsp_document_symbols: Get all symbols in file
`);
        prompt();
        return;
      }

      // ============================================
      // Reports Commands
      // ============================================

      // Handle /reports command
      if (trimmed === "/reports" || trimmed.startsWith("/reports ")) {
        const result = handleReportCommands(trimmed);
        if (result) {
          console.log(result);
        }
        prompt();
        return;
      }

      // Handle /report <id> command
      if (trimmed.startsWith("/report ")) {
        const result = handleReportCommands(trimmed);
        if (result) {
          console.log(result);
        }
        prompt();
        return;
      }

      // Toggle reporting
      if (trimmed === "/reporting") {
        const current = agent.isReportingEnabled();
        agent.setReportingEnabled(!current);
        console.log(`Completion reports: ${!current ? "\x1b[32mON\x1b[0m" : "\x1b[33mOFF\x1b[0m"}`);
        prompt();
        return;
      }

      // Background task commands
      if (trimmed === "/bg") {
        const taskManager = getBackgroundTaskManager();
        const tasks = taskManager.listTasks({ limit: 10 });
        if (tasks.length === 0) {
          console.log("\x1b[33mNo background tasks.\x1b[0m");
        } else {
          console.log("\x1b[36mBackground Tasks:\x1b[0m");
          for (const task of tasks) {
            console.log(`  ${formatTaskStatus(task)}`);
          }
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/bg ")) {
        const taskId = trimmed.slice(4).trim();
        const taskManager = getBackgroundTaskManager();
        const status = taskManager.getTaskStatus(taskId);
        const output = taskManager.getTaskOutput(taskId);
        if (!status || !output) {
          console.log(`\x1b[31mTask not found: ${taskId}\x1b[0m`);
        } else {
          console.log(formatTaskOutput(output, status));
        }
        prompt();
        return;
      }

      // ============================================
      // Permission Commands
      // ============================================

      if (trimmed === "/permissions") {
        const permManager = getPermissionManager();
        const config = permManager.getConfig();
        const log = permManager.getLog();
        console.log(`\n\x1b[36mPermission Config:\x1b[0m`);
        console.log(`  Auto-approve: ${config.autoApprove ? "\x1b[32mON\x1b[0m" : "\x1b[33mOFF\x1b[0m"}`);
        console.log(`  Allowed patterns: ${config.allowedPatterns.length}`);
        for (const p of config.allowedPatterns.slice(0, 5)) {
          console.log(`    - ${p}`);
        }
        if (config.allowedPatterns.length > 5) {
          console.log(`    ... and ${config.allowedPatterns.length - 5} more`);
        }
        console.log(`  Denied patterns: ${config.deniedPatterns.length}`);
        for (const p of config.deniedPatterns) {
          console.log(`    - ${p}`);
        }
        console.log(`\n\x1b[36mSession Stats:\x1b[0m`);
        console.log(`  Approved: ${log.approvedCount}`);
        console.log(`  Auto-approved: ${log.autoApprovedCount}`);
        console.log(`  Denied: ${log.deniedCount}`);
        prompt();
        return;
      }

      if (trimmed.startsWith("/allow ")) {
        const pattern = trimmed.slice(7).trim();
        if (pattern) {
          const permManager = getPermissionManager();
          permManager.allowPattern(pattern);
          console.log(`\x1b[32mAllowed pattern:\x1b[0m ${pattern}`);
        } else {
          console.log("\x1b[31mUsage: /allow <pattern>\x1b[0m");
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/deny ")) {
        const pattern = trimmed.slice(6).trim();
        if (pattern) {
          const permManager = getPermissionManager();
          permManager.denyPattern(pattern);
          console.log(`\x1b[31mDenied pattern:\x1b[0m ${pattern}`);
        } else {
          console.log("\x1b[31mUsage: /deny <pattern>\x1b[0m");
        }
        prompt();
        return;
      }

      if (trimmed === "/auto-approve") {
        const permManager = getPermissionManager();
        const current = permManager.getConfig().autoApprove;
        permManager.setAutoApprove(!current);
        console.log(`Auto-approve: ${!current ? "\x1b[32mON\x1b[0m" : "\x1b[33mOFF\x1b[0m"}`);
        prompt();
        return;
      }

      // ============================================
      // Hooks Commands
      // ============================================

      if (trimmed === "/hooks") {
        const hooksManager = getHookManager();
        const hooks = hooksManager.getAllHooks();
        console.log(`\n\x1b[36mRegistered Hooks:\x1b[0m (${hooks.length} total)`);
        if (hooks.length === 0) {
          console.log("  No hooks registered. Add hooks to ~/.8gent/hooks.json");
        }
        for (const hook of hooks) {
          const status = hook.enabled ? "\x1b[32m[ON]\x1b[0m" : "\x1b[33m[OFF]\x1b[0m";
          console.log(`  ${status} ${hook.name} (${hook.type})`);
          console.log(`       ID: ${hook.id}`);
          if (hook.description) {
            console.log(`       ${hook.description}`);
          }
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/hooks enable ")) {
        const hookId = trimmed.slice(14).trim();
        if (hookId) {
          const hooksManager = getHookManager();
          if (hooksManager.enableHook(hookId)) {
            console.log(`\x1b[32mEnabled hook:\x1b[0m ${hookId}`);
          } else {
            console.log(`\x1b[31mHook not found:\x1b[0m ${hookId}`);
          }
        } else {
          console.log("\x1b[31mUsage: /hooks enable <hook-id>\x1b[0m");
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/hooks disable ")) {
        const hookId = trimmed.slice(15).trim();
        if (hookId) {
          const hooksManager = getHookManager();
          if (hooksManager.disableHook(hookId)) {
            console.log(`\x1b[33mDisabled hook:\x1b[0m ${hookId}`);
          } else {
            console.log(`\x1b[31mHook not found:\x1b[0m ${hookId}`);
          }
        } else {
          console.log("\x1b[31mUsage: /hooks disable <hook-id>\x1b[0m");
        }
        prompt();
        return;
      }

      // ============================================
      // Skills Commands
      // ============================================

      if (trimmed === "/skills") {
        try {
          const skillManager = getSkillManager();
          await skillManager.loadSkills();
          const skills = skillManager.getAllSkills();
          console.log(`\n\x1b[36mAvailable Skills:\x1b[0m (${skills.length})`);
          console.log(`Skills directory: ${skillManager.getSkillsDirectory()}\n`);
          for (const skill of skills) {
            console.log(`  \x1b[33m/${skill.name}\x1b[0m - ${skill.description}`);
            if (skill.tools.length > 0) {
              console.log(`    Tools: ${skill.tools.join(", ")}`);
            }
          }
          if (skills.length === 0) {
            console.log("  No skills found. Create .md files in ~/.8gent/skills/");
          }
        } catch (err) {
          console.error(`\x1b[31mError loading skills: ${err}\x1b[0m`);
        }
        prompt();
        return;
      }

      // ============================================
      // Multi-Agent Commands
      // ============================================

      if (trimmed.startsWith("/spawn ")) {
        const parsed = parseSpawnCommand(trimmed);
        if (!parsed || !parsed.task) {
          console.log("\x1b[31mUsage: /spawn <task description> [--model <model>] [--dir <path>]\x1b[0m");
          prompt();
          return;
        }

        try {
          const pool = getAgentPool();
          const spawnedAgent = await pool.spawnAgent(parsed.task, parsed.options);
          console.log(`\n\x1b[32mSpawned agent:\x1b[0m ${spawnedAgent.id}`);
          console.log(`  Task: ${parsed.task}`);
          console.log(`  Model: ${spawnedAgent.config.model}`);
          console.log(`\nUse /agents to check status, /join ${spawnedAgent.id} to wait for completion.`);
        } catch (err) {
          console.error(`\x1b[31mFailed to spawn agent: ${err}\x1b[0m`);
        }
        prompt();
        return;
      }

      if (trimmed === "/agents") {
        const pool = getAgentPool();
        const agents = pool.listAgents();
        const stats = pool.getStats();

        console.log(`\n\x1b[36mAgent Pool:\x1b[0m`);
        console.log(`  Running: ${stats.running}/${pool.getMaxConcurrent()} | Completed: ${stats.completed} | Failed: ${stats.failed}\n`);

        if (agents.length === 0) {
          console.log("  No agents. Use /spawn <task> to create one.");
        } else {
          for (const spawnedAgent of agents) {
            console.log(`  ${formatAgentStatus(spawnedAgent)}`);
          }
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/join ")) {
        const agentId = trimmed.slice(6).trim();
        const pool = getAgentPool();

        const spawnedAgent = pool.getAgent(agentId);
        if (!spawnedAgent) {
          console.log(`\x1b[31mAgent not found: ${agentId}\x1b[0m`);
          prompt();
          return;
        }

        if (spawnedAgent.status === "completed" || spawnedAgent.status === "failed") {
          console.log(`\n\x1b[36mAgent ${agentId}:\x1b[0m ${spawnedAgent.status}`);
          if (spawnedAgent.task.result) {
            console.log(`\x1b[32mResult:\x1b[0m ${String(spawnedAgent.task.result).slice(0, 500)}`);
          }
          if (spawnedAgent.task.error) {
            console.log(`\x1b[31mError:\x1b[0m ${spawnedAgent.task.error}`);
          }
        } else {
          console.log(`\x1b[33mWaiting for agent ${agentId} to complete...\x1b[0m`);
          try {
            const result = await pool.joinAgent(agentId, 300000);
            console.log(`\n\x1b[32mAgent completed:\x1b[0m`);
            if (result.task.result) {
              console.log(String(result.task.result).slice(0, 500));
            }
          } catch (err) {
            console.error(`\x1b[31mError waiting for agent: ${err}\x1b[0m`);
          }
        }
        prompt();
        return;
      }

      if (trimmed.startsWith("/kill ")) {
        const agentId = trimmed.slice(6).trim();
        const pool = getAgentPool();

        const killed = pool.cancelAgent(agentId);
        if (killed) {
          console.log(`\n\x1b[32mAgent killed:\x1b[0m ${agentId}`);
        } else {
          console.log(`\x1b[31mCould not kill agent ${agentId} (not found or already completed)\x1b[0m`);
        }
        prompt();
        return;
      }

      // ============================================
      // Subagent Commands (Plan-Validate Loop)
      // ============================================

      if (trimmed.startsWith("/agent ")) {
        const agentId = trimmed.slice(7).trim();
        try {
          const { getSubAgentManager, formatSubAgentStatus, formatSubAgentEvidence } = await import("../orchestration/subagent");
          const subAgentMgr = getSubAgentManager();
          const subAgent = subAgentMgr.getStatus(agentId);

          if (!subAgent) {
            console.log(`\x1b[31mSubagent not found: ${agentId}\x1b[0m`);
          } else {
            console.log(`\n\x1b[36mSubagent Details:\x1b[0m`);
            console.log(`  ${formatSubAgentStatus(subAgent)}`);
            console.log(`\n  Task: ${subAgent.task}`);
            console.log(`  Status: ${subAgent.status}`);
            console.log(`  Steps: ${subAgent.plan.length}`);
            console.log(`\n${formatSubAgentEvidence(subAgent)}`);

            if (subAgent.validationReport) {
              console.log(`\n\x1b[36mValidation Report:\x1b[0m`);
              console.log(`  Confidence: ${subAgent.validationReport.confidence}%`);
              console.log(`  Passed: ${subAgent.validationReport.passedSteps}/${subAgent.validationReport.totalSteps}`);
              console.log(`  Evidence: ${subAgent.validationReport.evidence.length} items`);
            }
          }
        } catch (err) {
          console.error(`\x1b[31mError: ${err}\x1b[0m`);
        }
        prompt();
        return;
      }

      if (trimmed === "/evidence") {
        try {
          const { getSubAgentManager } = await import("../orchestration/subagent");
          const { formatEvidence, summarizeEvidence } = await import("../validation/evidence");
          const subAgentMgr = getSubAgentManager();
          const agents = subAgentMgr.listAgents();

          console.log(`\n\x1b[36mCollected Evidence:\x1b[0m\n`);

          let totalEvidence: import("../validation/evidence").Evidence[] = [];
          for (const agent of agents) {
            if (agent.evidence.length > 0) {
              console.log(`\x1b[33m${agent.id}:\x1b[0m ${agent.task.slice(0, 40)}...`);
              console.log(formatEvidence(agent.evidence));
              console.log("");
              totalEvidence = totalEvidence.concat(agent.evidence);
            }
          }

          if (totalEvidence.length === 0) {
            console.log("  No evidence collected yet.");
            console.log("  Evidence is collected when subagents execute tasks.");
          } else {
            const summary = summarizeEvidence(totalEvidence);
            console.log(`\x1b[36mTotal:\x1b[0m ${summary.total} items | ${summary.verified} verified | ${summary.failed} failed`);
          }
        } catch (err) {
          console.error(`\x1b[31mError: ${err}\x1b[0m`);
        }
        prompt();
        return;
      }

      // ============================================
      // Task Commands
      // ============================================

      if (trimmed === "/tasks" || trimmed === "/tasks -v" || trimmed === "/tasks --verbose") {
        const taskMgr = getTaskManager();
        const tasks = taskMgr.listTasks();
        const stats = taskMgr.getStats();
        const verbose = trimmed.includes("-v") || trimmed.includes("--verbose");

        console.log(`\n\x1b[36mTasks:\x1b[0m ${stats.total} total | ${stats.pending} pending | ${stats.inProgress} in progress | ${stats.completed} done\n`);

        if (tasks.length === 0) {
          console.log("  No tasks. Use /task \"description\" to create one.");
        } else {
          for (const task of tasks) {
            console.log(`  ${formatTask(task, verbose)}`);
          }
        }
        prompt();
        return;
      }

      // Parse task commands
      const taskCmd = parseTaskCommand(trimmed);
      if (taskCmd) {
        const taskMgr = getTaskManager();

        switch (taskCmd.action) {
          case "create":
            if (!taskCmd.subject) {
              console.log("\x1b[31mUsage: /task \"description\" [--priority high] [--tag tag1]\x1b[0m");
            } else {
              const task = taskMgr.createTask(taskCmd.subject, "", {
                priority: taskCmd.options.priority,
                tags: taskCmd.options.tags,
                owner: taskCmd.options.owner,
              });
              console.log(`\n\x1b[32mTask created:\x1b[0m ${task.id}`);
              console.log(`  ${formatTask(task)}`);
            }
            break;

          case "done":
            if (!taskCmd.taskId) {
              console.log("\x1b[31mUsage: /task:done <task-id>\x1b[0m");
            } else {
              const task = taskMgr.completeTask(taskCmd.taskId);
              if (task) {
                console.log(`\n\x1b[32mTask completed:\x1b[0m ${formatTask(task)}`);
              } else {
                console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
              }
            }
            break;

          case "start":
            if (!taskCmd.taskId) {
              console.log("\x1b[31mUsage: /task:start <task-id>\x1b[0m");
            } else {
              const task = taskMgr.startTask(taskCmd.taskId);
              if (task) {
                console.log(`\n\x1b[33mTask started:\x1b[0m ${formatTask(task)}`);
              } else {
                console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
              }
            }
            break;

          case "delete":
            if (!taskCmd.taskId) {
              console.log("\x1b[31mUsage: /task:delete <task-id>\x1b[0m");
            } else {
              const deleted = taskMgr.deleteTask(taskCmd.taskId);
              if (deleted) {
                console.log(`\n\x1b[32mTask deleted:\x1b[0m ${taskCmd.taskId}`);
              } else {
                console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
              }
            }
            break;

          case "show":
            if (!taskCmd.taskId) {
              console.log("\x1b[31mUsage: /task:show <task-id>\x1b[0m");
            } else {
              const task = taskMgr.getTask(taskCmd.taskId);
              if (task) {
                console.log(`\n${formatTask(task, true)}`);
                if (task.notes.length > 0) {
                  console.log(`\n  Notes:`);
                  for (const note of task.notes) {
                    console.log(`    - ${note}`);
                  }
                }
              } else {
                console.log(`\x1b[31mTask not found: ${taskCmd.taskId}\x1b[0m`);
              }
            }
            break;

          case "block":
            if (!taskCmd.taskId || !taskCmd.options.blockedBy) {
              console.log("\x1b[31mUsage: /task:block <task-id> <blocked-by-id>\x1b[0m");
            } else {
              const task = taskMgr.blockTask(taskCmd.taskId, taskCmd.options.blockedBy);
              if (task) {
                console.log(`\n\x1b[33mTask blocked:\x1b[0m ${formatTask(task)}`);
              } else {
                console.log(`\x1b[31mTask not found\x1b[0m`);
              }
            }
            break;
        }
        prompt();
        return;
      }

      // ============================================
      // Skill Invocation (/<skill-name>)
      // ============================================

      if (trimmed.startsWith("/") && !trimmed.startsWith("/model") && !trimmed.startsWith("/plan")) {
        const skillCmd = parseSkillCommand(trimmed);
        if (skillCmd) {
          try {
            const skillManager = getSkillManager();
            await skillManager.loadSkills();
            const skill = skillManager.getSkill(skillCmd.name);

            if (skill) {
              console.log(`\n\x1b[36mInvoking skill:\x1b[0m ${skill.name}`);
              console.log(`\x1b[90m${skill.description}\x1b[0m\n`);

              // Build prompt with skill instructions
              let fullPrompt = `[SKILL: ${skill.name}]\n\n${skill.prompt}`;
              if (Object.keys(skillCmd.args).length > 0) {
                fullPrompt += `\n\n## Arguments\n${JSON.stringify(skillCmd.args, null, 2)}`;
              }

              try {
                const response = await agent.chat(fullPrompt);
                console.log(`\n\x1b[32m${response}\x1b[0m`);
              } catch (err) {
                console.error(`\x1b[31mSkill error: ${err}\x1b[0m`);
              }
              prompt();
              return;
            }
          } catch (err) {
            // Not a skill, continue to regular chat
          }
        }
      }

      try {
        const response = await agent.chat(trimmed);
        console.log(`\n\x1b[32m${response}\x1b[0m`);
      } catch (err) {
        console.error(`\x1b[31mError: ${err}\x1b[0m`);
      }

      prompt();
    });
  };

  prompt();
}

// Run REPL if executed directly
if (import.meta.main) {
  // Check for CLI argument for non-interactive mode
  const args = process.argv.slice(2);
  if (args.length > 0 && args[0] !== "--interactive") {
    // Non-interactive mode: run single prompt and exit
    const promptText = args.join(" ");
    (async () => {
      const config: AgentConfig = {
        model: process.env.EIGHGENT_MODEL || "glm-4.7-flash:latest",
        runtime: "ollama",
        workingDirectory: process.cwd(),
        maxTurns: 30,
      };
      const agent = new Agent(config);
      if (!(await agent.isReady())) {
        console.error("Ollama is not running");
        process.exit(1);
      }
      console.log(`\n🎯 Task: ${promptText}\n`);
      try {
        const response = await agent.chat(promptText);
        console.log(`\n✅ Result:\n${response}`);
      } catch (err) {
        console.error(`❌ Error: ${err}`);
      }
      process.exit(0);
    })();
  } else {
    startREPL();
  }
}
