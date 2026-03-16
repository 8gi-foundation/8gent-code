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
  getPermissionManager,
  isCommandDangerous,
  type PermissionManager,
} from "../permissions";
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
} from "../tools/background";

/**
 * Validate that a user-provided path stays within the working directory.
 * Prevents path traversal attacks (../../etc/passwd).
 */
function safePath(userPath: string, workingDirectory: string): string {
  const absolutePath = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(workingDirectory, userPath);

  const normalizedBase = path.resolve(workingDirectory) + path.sep;
  const normalizedTarget = path.resolve(absolutePath);

  // Allow the working directory itself
  if (normalizedTarget === path.resolve(workingDirectory)) return normalizedTarget;

  // Must be inside the working directory
  if (!normalizedTarget.startsWith(normalizedBase)) {
    throw new Error(`Path traversal blocked: "${userPath}" resolves outside working directory`);
  }

  return normalizedTarget;
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

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
    this.permissionManager = getPermissionManager();
    this.hookManager = getHookManager();
    this.hookManager.setWorkingDirectory(workingDirectory);
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
          description: "Get the outline (functions, classes, etc.) of a source file. Use this FIRST before reading full files to understand structure.",
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
          description: "Get the full source code of a specific symbol (function, class, etc.)",
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
          description: "Search for symbols (functions, classes, etc.) across the codebase",
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
      // File operations
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read the contents of a file",
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
          description: "Write content to a file (creates or overwrites)",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to the file" },
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
          description: "Edit a file by replacing text",
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
          description: "List files in a directory",
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
          description: "Get git status",
          parameters: { type: "object", properties: {} }
        }
      },
      {
        type: "function",
        function: {
          name: "git_diff",
          description: "Show git diff",
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
          description: "Show git commit log",
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
          description: "Stage files for commit",
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
          description: "Create a git commit",
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
          description: "Run a shell command",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Command to run" }
            },
            required: ["command"]
          }
        }
      },
      // Web tools
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web",
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
          description: "Fetch content from a URL",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to fetch" }
            },
            required: ["url"]
          }
        }
      }
    ];
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

    // Auto-open files on macOS for immediate viewing
    if (process.platform === "darwin") {
      try {
        const { spawn } = await import("child_process");
        spawn("open", [absolutePath], { detached: true, stdio: "ignore" }).unref();
      } catch {}
    }

    return `File written and opened: ${absolutePath}`;
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
