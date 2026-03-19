/**
 * 8gent AI - Tool Definitions (AI SDK format)
 *
 * All tools defined using the Vercel AI SDK `tool()` helper with Zod schemas.
 * These replace the raw JSON schema definitions in eight/tools.ts.
 *
 * Tools are split into groups and composed into a single ToolSet.
 */

import { tool } from "ai";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import type { ToolSet } from "ai";

// Execution context passed to tools
export interface ToolContext {
  workingDirectory: string;
}

let _ctx: ToolContext = { workingDirectory: process.cwd() };

export function setToolContext(ctx: ToolContext): void {
  _ctx = ctx;
}

export function getToolContext(): ToolContext {
  return _ctx;
}

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(_ctx.workingDirectory, p);
}

// ============================================
// Code Exploration Tools
// ============================================

const getOutline = tool({
  description:
    "Get the outline (functions, classes, etc.) of a source file. Use this FIRST before reading full files to understand structure.",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file to analyze"),
  }),
  execute: async ({ filePath }) => {
    const { parseTypeScriptFile } = await import("../ast-index/typescript-parser");
    const absolutePath = resolvePath(filePath);
    if (!fs.existsSync(absolutePath)) return `File not found: ${absolutePath}`;

    try {
      const outline = parseTypeScriptFile(absolutePath);
      const symbols = outline.symbols.map((s: any) => ({
        name: s.name,
        kind: s.kind,
        lines: `${s.startLine}-${s.endLine}`,
        signature: s.signature?.slice(0, 80),
      }));
      return JSON.stringify(
        { filePath: absolutePath, language: outline.language, symbolCount: symbols.length, symbols },
        null,
        2
      );
    } catch (err) {
      return `Error parsing file: ${err}`;
    }
  },
});

const getSymbol = tool({
  description: "Get the full source code of a specific symbol (function, class, etc.)",
  inputSchema: z.object({
    symbolId: z.string().describe("Symbol ID in format 'path/to/file.ts::symbolName'"),
  }),
  execute: async ({ symbolId }) => {
    const { parseTypeScriptFile, getSymbolSource } = await import("../ast-index/typescript-parser");
    const separatorIndex = symbolId.lastIndexOf("::");
    if (separatorIndex === -1) return "Invalid symbol ID format. Expected 'path/to/file.ts::symbolName'";

    const filePath = symbolId.slice(0, separatorIndex);
    const symbolName = symbolId.slice(separatorIndex + 2);
    const absolutePath = resolvePath(filePath);
    if (!fs.existsSync(absolutePath)) return `File not found: ${absolutePath}`;

    try {
      const outline = parseTypeScriptFile(absolutePath);
      const symbol = outline.symbols.find((s: any) => s.name === symbolName);
      if (!symbol)
        return `Symbol '${symbolName}' not found. Available: ${outline.symbols.map((s: any) => s.name).join(", ")}`;
      const source = getSymbolSource(absolutePath, symbol.startLine, symbol.endLine);
      return `// ${symbol.kind}: ${symbol.name}\n// Lines ${symbol.startLine}-${symbol.endLine}\n\n${source}`;
    } catch (err) {
      return `Error: ${err}`;
    }
  },
});

const searchSymbols = tool({
  description: "Search for symbols (functions, classes, etc.) across the codebase",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    kinds: z.array(z.string()).optional().describe("Filter by kinds: function, class, method, variable"),
  }),
  execute: async ({ query, kinds }) => {
    const { parseTypeScriptFile } = await import("../ast-index/typescript-parser");
    const { glob } = await import("glob");

    const files = await glob("**/*.{ts,tsx,js,jsx}", {
      cwd: _ctx.workingDirectory,
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
              file: path.relative(_ctx.workingDirectory, file),
              line: symbol.startLine,
            });
          }
          if (matches.length >= 20) break;
        }
      } catch {}
      if (matches.length >= 20) break;
    }

    return JSON.stringify({ query, matches }, null, 2);
  },
});

// ============================================
// File Operations
// ============================================

const readFile = tool({
  description: "Read the contents of a file",
  inputSchema: z.object({
    path: z.string().describe("Path to the file to read"),
  }),
  execute: async ({ path: filePath }) => {
    const absolutePath = resolvePath(filePath);
    if (!fs.existsSync(absolutePath)) return `File not found: ${absolutePath}`;

    const content = fs.readFileSync(absolutePath, "utf-8");
    const lines = content.split("\n");
    if (lines.length > 200) {
      return `// File has ${lines.length} lines. Showing first 200:\n\n${lines.slice(0, 200).join("\n")}\n\n// ... truncated. Use get_outline + get_symbol for specific sections.`;
    }
    return content;
  },
});

const writeFile = tool({
  description: "Write content to a file (creates or overwrites)",
  inputSchema: z.object({
    path: z.string().describe("Path to the file"),
    content: z.string().describe("Content to write"),
  }),
  execute: async ({ path: filePath, content }) => {
    const absolutePath = resolvePath(filePath);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absolutePath, content);
    return `File written: ${absolutePath}`;
  },
});

const editFile = tool({
  description: "Edit a file by replacing text",
  inputSchema: z.object({
    path: z.string().describe("Path to the file"),
    oldText: z.string().describe("Text to find and replace"),
    newText: z.string().describe("Replacement text"),
  }),
  execute: async ({ path: filePath, oldText, newText }) => {
    const absolutePath = resolvePath(filePath);
    if (!fs.existsSync(absolutePath)) return `File not found: ${absolutePath}`;
    const content = fs.readFileSync(absolutePath, "utf-8");
    if (!content.includes(oldText))
      return `Error: Could not find the text to replace in ${filePath}. Make sure oldText matches exactly.`;
    fs.writeFileSync(absolutePath, content.replace(oldText, newText));
    return `File edited: ${absolutePath}\nReplaced ${oldText.length} chars with ${newText.length} chars.`;
  },
});

const listFiles = tool({
  description: "List files in a directory",
  inputSchema: z.object({
    path: z.string().optional().describe("Directory path (default: current directory)"),
    pattern: z.string().optional().describe("Glob pattern to filter files"),
  }),
  execute: async ({ path: dirPath, pattern }) => {
    const { glob } = await import("glob");
    const absolutePath = resolvePath(dirPath || ".");
    const files = await glob(pattern || "**/*", {
      cwd: absolutePath,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    });
    // Mark directories with trailing /
    const { stat: fsStat } = await import("fs/promises");
    const results: string[] = [];
    for (const f of files.slice(0, 100)) {
      try {
        const s = await fsStat(path.join(absolutePath, f));
        results.push(s.isDirectory() ? f + "/" : f);
      } catch {
        results.push(f);
      }
    }
    return results.join("\n") || "(empty directory)";
  },
});

// ============================================
// Git Operations
// ============================================

const gitStatus = tool({
  description: "Get git status",
  inputSchema: z.object({}),
  execute: async () => runShellCommand("git status"),
});

const gitDiff = tool({
  description: "Show git diff",
  inputSchema: z.object({
    staged: z.boolean().optional().describe("Show staged changes only"),
  }),
  execute: async ({ staged }) => runShellCommand(staged ? "git diff --staged" : "git diff"),
});

const gitLog = tool({
  description: "Show git commit log",
  inputSchema: z.object({
    count: z.number().optional().describe("Number of commits to show (default: 10)"),
  }),
  execute: async ({ count }) => runShellCommand(`git log --oneline -${count || 10}`),
});

const gitAdd = tool({
  description: "Stage files for commit",
  inputSchema: z.object({
    files: z.string().optional().describe("Files to add (default: all)"),
  }),
  execute: async ({ files }) => runShellCommand(`git add ${files || "."}`),
});

const gitCommit = tool({
  description: "Create a git commit",
  inputSchema: z.object({
    message: z.string().describe("Commit message"),
  }),
  execute: async ({ message }) => runShellCommand(`git commit -m "${message}"`),
});

const gitPush = tool({
  description: "Push to remote",
  inputSchema: z.object({
    setUpstream: z.boolean().optional().describe("Set upstream tracking"),
  }),
  execute: async ({ setUpstream }) =>
    runShellCommand(`git push ${setUpstream ? "-u origin HEAD" : ""}`),
});

const gitBranch = tool({
  description: "List all git branches",
  inputSchema: z.object({}),
  execute: async () => runShellCommand("git branch -a"),
});

const gitCheckout = tool({
  description: "Checkout a git branch",
  inputSchema: z.object({
    branch: z.string().describe("Branch name to checkout"),
  }),
  execute: async ({ branch }) => runShellCommand(`git checkout ${branch}`),
});

const gitCreateBranch = tool({
  description: "Create and checkout a new git branch",
  inputSchema: z.object({
    branch: z.string().describe("New branch name"),
  }),
  execute: async ({ branch }) => runShellCommand(`git checkout -b ${branch}`),
});

// ============================================
// GitHub CLI Tools
// ============================================

const ghPrList = tool({
  description: "List pull requests",
  inputSchema: z.object({}),
  execute: async () => runShellCommand("gh pr list"),
});

const ghPrCreate = tool({
  description: "Create a pull request",
  inputSchema: z.object({
    title: z.string().describe("PR title"),
    body: z.string().optional().describe("PR description"),
  }),
  execute: async ({ title, body }) =>
    runShellCommand(`gh pr create --title "${title}" --body "${body || ""}"`),
});

const ghPrView = tool({
  description: "View a pull request",
  inputSchema: z.object({
    number: z.number().optional().describe("PR number (default: current branch PR)"),
  }),
  execute: async ({ number }) => runShellCommand(`gh pr view ${number || ""}`),
});

const ghIssueList = tool({
  description: "List issues",
  inputSchema: z.object({}),
  execute: async () => runShellCommand("gh issue list"),
});

const ghIssueCreate = tool({
  description: "Create an issue",
  inputSchema: z.object({
    title: z.string().describe("Issue title"),
    body: z.string().optional().describe("Issue description"),
  }),
  execute: async ({ title, body }) =>
    runShellCommand(`gh issue create --title "${title}" --body "${body || ""}"`),
});

// ============================================
// Shell
// ============================================

const runCommand = tool({
  description: "Run a shell command",
  inputSchema: z.object({
    command: z.string().describe("Command to run"),
  }),
  execute: async ({ command }) => runShellCommand(command),
});

// ============================================
// LSP Tools
// ============================================

const lspGotoDefinition = tool({
  description: "Go to the definition of a symbol at a specific location",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file"),
    line: z.number().describe("Line number (0-based)"),
    character: z.number().describe("Character offset (0-based)"),
  }),
  execute: async ({ filePath, line, character }) => {
    const { lspGoToDefinition } = await import("../lsp");
    return lspGoToDefinition(filePath, line, character, _ctx.workingDirectory);
  },
});

const lspFindReferences = tool({
  description: "Find all references to a symbol",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file"),
    line: z.number().describe("Line number (0-based)"),
    character: z.number().describe("Character offset (0-based)"),
  }),
  execute: async ({ filePath, line, character }) => {
    const { lspFindReferences } = await import("../lsp");
    return lspFindReferences(filePath, line, character, _ctx.workingDirectory);
  },
});

const lspHover = tool({
  description: "Get hover information about a symbol",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file"),
    line: z.number().describe("Line number (0-based)"),
    character: z.number().describe("Character offset (0-based)"),
  }),
  execute: async ({ filePath, line, character }) => {
    const { lspHover } = await import("../lsp");
    return lspHover(filePath, line, character, _ctx.workingDirectory);
  },
});

const lspDocumentSymbols = tool({
  description: "Get all symbols in a document via LSP",
  inputSchema: z.object({
    filePath: z.string().describe("Path to the file"),
  }),
  execute: async ({ filePath }) => {
    const { lspDocumentSymbols } = await import("../lsp");
    return lspDocumentSymbols(filePath, _ctx.workingDirectory);
  },
});

// ============================================
// Image Tools
// ============================================

const readImage = tool({
  description: "Read image metadata and base64 data",
  inputSchema: z.object({
    path: z.string().describe("Path to the image file"),
  }),
  execute: async ({ path: imagePath }) => {
    const { readImage } = await import("../tools/image");
    const absolutePath = resolvePath(imagePath);
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
  },
});

const describeImage = tool({
  description: "Describe an image using vision model",
  inputSchema: z.object({
    path: z.string().describe("Path to the image file"),
    prompt: z.string().optional().describe("Custom prompt for description"),
  }),
  execute: async ({ path: imagePath, prompt }) => {
    const { describeImage } = await import("../tools/image");
    const absolutePath = resolvePath(imagePath);
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
  },
});

// ============================================
// PDF Tools
// ============================================

const readPdf = tool({
  description: "Read entire PDF content",
  inputSchema: z.object({
    path: z.string().describe("Path to the PDF file"),
  }),
  execute: async ({ path: pdfPath }) => {
    const absolutePath = resolvePath(pdfPath);
    try {
      // PDF support is stubbed for now
      throw new Error("PDF support coming soon");
    } catch (err) {
      return `Error reading PDF: ${err}`;
    }
  },
});

const readPdfPage = tool({
  description: "Read a specific page of a PDF",
  inputSchema: z.object({
    path: z.string().describe("Path to the PDF file"),
    pageNum: z.number().describe("Page number to read"),
  }),
  execute: async ({ path: pdfPath, pageNum }) => {
    const absolutePath = resolvePath(pdfPath);
    try {
      throw new Error("PDF support coming soon");
    } catch (err) {
      return `Error reading PDF page: ${err}`;
    }
  },
});

// ============================================
// Notebook Tools
// ============================================

const readNotebook = tool({
  description: "Read a Jupyter notebook file",
  inputSchema: z.object({
    path: z.string().describe("Path to the notebook file"),
  }),
  execute: async ({ path: notebookPath }) => {
    const { readNotebook } = await import("../tools/notebook");
    const absolutePath = resolvePath(notebookPath);
    try {
      const notebook = await readNotebook(absolutePath);
      const formattedCells = notebook.cells.map((cell: any) => ({
        index: cell.index,
        type: cell.type,
        executionCount: cell.executionCount,
        source: cell.source.length > 500
          ? cell.source.slice(0, 500) + "... [truncated]"
          : cell.source,
        outputCount: cell.outputs.length,
        outputs: cell.outputs.slice(0, 3).map((o: any) => ({
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
  },
});

const notebookEditCell = tool({
  description: "Edit a notebook cell by index",
  inputSchema: z.object({
    path: z.string().describe("Path to the notebook file"),
    cellIndex: z.number().describe("Cell index to edit"),
    newSource: z.string().describe("New cell source content"),
  }),
  execute: async ({ path: notebookPath, cellIndex, newSource }) => {
    const { editCell } = await import("../tools/notebook");
    const absolutePath = resolvePath(notebookPath);
    try {
      const result = await editCell(absolutePath, cellIndex, newSource);
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error editing notebook cell: ${err}`;
    }
  },
});

const notebookInsertCell = tool({
  description: "Insert a new cell into a notebook",
  inputSchema: z.object({
    path: z.string().describe("Path to the notebook file"),
    afterIndex: z.number().describe("Insert after this cell index"),
    cellType: z.enum(["code", "markdown"]).describe("Cell type"),
    source: z.string().describe("Cell source content"),
  }),
  execute: async ({ path: notebookPath, afterIndex, cellType, source }) => {
    const { insertCell } = await import("../tools/notebook");
    const absolutePath = resolvePath(notebookPath);
    try {
      const result = await insertCell(absolutePath, afterIndex, cellType, source);
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error inserting notebook cell: ${err}`;
    }
  },
});

const notebookDeleteCell = tool({
  description: "Delete a notebook cell",
  inputSchema: z.object({
    path: z.string().describe("Path to the notebook file"),
    cellIndex: z.number().describe("Cell index to delete"),
  }),
  execute: async ({ path: notebookPath, cellIndex }) => {
    const { deleteCell } = await import("../tools/notebook");
    const absolutePath = resolvePath(notebookPath);
    try {
      const result = await deleteCell(absolutePath, cellIndex);
      return JSON.stringify(result, null, 2);
    } catch (err) {
      return `Error deleting notebook cell: ${err}`;
    }
  },
});

// ============================================
// Web Tools
// ============================================

const webSearchTool = tool({
  description: "Search the web",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().describe("Max results (default: 5)"),
  }),
  execute: async ({ query, maxResults }) => {
    try {
      const { webSearch, formatSearchResults } = await import("../tools/web");
      const results = await webSearch(query, { maxResults: maxResults || 10 });
      return formatSearchResults(results);
    } catch (err) {
      return `Web search failed: ${err}`;
    }
  },
});

const webFetchTool = tool({
  description: "Fetch content from a URL",
  inputSchema: z.object({
    url: z.string().describe("URL to fetch"),
  }),
  execute: async ({ url }) => {
    try {
      const { webFetch, formatFetchResult } = await import("../tools/web");
      const result = await webFetch(url);
      return formatFetchResult(result);
    } catch (err) {
      return `Web fetch failed: ${err}`;
    }
  },
});

// ============================================
// MCP Tools
// ============================================

const mcpListTools = tool({
  description: "List all available MCP tools from configured servers",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const { getMCPClient } = await import("../mcp");
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
  },
});

const mcpCallTool = tool({
  description: "Call a specific MCP tool",
  inputSchema: z.object({
    server: z.string().describe("MCP server name"),
    tool: z.string().describe("Tool name"),
    args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
  }),
  execute: async ({ server, tool: toolName, args }) => {
    try {
      const { getMCPClient, formatToolResult } = await import("../mcp");
      const mcpClient = getMCPClient();
      const result = await mcpClient.callTool(server, toolName, args);
      return formatToolResult(result);
    } catch (err) {
      return `MCP call tool failed: ${err}`;
    }
  },
});

// ============================================
// Background Task Tools
// ============================================

const backgroundStart = tool({
  description: "Start a background task and return task ID",
  inputSchema: z.object({
    command: z.string().describe("Command to run in background"),
    timeout: z.number().optional().describe("Timeout in milliseconds"),
  }),
  execute: async ({ command, timeout }) => {
    try {
      const { getBackgroundTaskManager } = await import("../tools/background");
      const taskManager = getBackgroundTaskManager(_ctx.workingDirectory);
      const taskId = taskManager.startTask(command, { timeout });
      return `Background task started: ${taskId}\nCommand: ${command}\nUse background_status or background_output to check progress.`;
    } catch (err) {
      return `Failed to start background task: ${err}`;
    }
  },
});

const backgroundStatus = tool({
  description: "Check status of a running background task",
  inputSchema: z.object({
    taskId: z.string().describe("Task ID to check"),
  }),
  execute: async ({ taskId }) => {
    try {
      const { getBackgroundTaskManager, formatTaskStatus } = await import("../tools/background");
      const taskManager = getBackgroundTaskManager();
      const status = taskManager.getTaskStatus(taskId);
      if (!status) return `Task not found: ${taskId}`;
      return formatTaskStatus(status);
    } catch (err) {
      return `Failed to get task status: ${err}`;
    }
  },
});

const backgroundOutput = tool({
  description: "Get output from a background task",
  inputSchema: z.object({
    taskId: z.string().describe("Task ID"),
    tail: z.number().optional().describe("Number of lines from end"),
  }),
  execute: async ({ taskId, tail }) => {
    try {
      const { getBackgroundTaskManager, formatTaskStatus, formatTaskOutput } = await import("../tools/background");
      const taskManager = getBackgroundTaskManager();
      const status = taskManager.getTaskStatus(taskId);
      const output = taskManager.getTaskOutput(taskId, { tail });
      if (!status || !output) return `Task not found: ${taskId}`;
      return formatTaskOutput(output, status);
    } catch (err) {
      return `Failed to get task output: ${err}`;
    }
  },
});

// ============================================
// Shell Command Runner (shared)
// ============================================

async function runShellCommand(command: string): Promise<string> {
  const { getPermissionManager, isCommandDangerous } = await import("../permissions");
  const { getHookManager } = await import("../hooks");

  const permissionManager = getPermissionManager();
  const hookManager = getHookManager();
  hookManager.setWorkingDirectory(_ctx.workingDirectory);

  const permissionCheck = permissionManager.checkPermission(command);
  if (permissionCheck === "denied") {
    return `[PERMISSION DENIED] Command blocked by security policy: ${command}`;
  }
  if (permissionCheck === "ask") {
    const allowed = await permissionManager.requestPermission(
      "Execute Shell Command",
      isCommandDangerous(command)
        ? "This command may modify system files or cause data loss."
        : "The agent wants to run a shell command.",
      command
    );
    if (!allowed) return `[PERMISSION DENIED] User declined to execute: ${command}`;
  }

  const startTime = Date.now();
  await hookManager.executeHooks("beforeCommand", {
    command,
    workingDirectory: _ctx.workingDirectory,
  });

  let finalCommand = command;
  if (command.includes("create-next-app") && !command.includes("--yes")) {
    finalCommand = command.replace("create-next-app", "create-next-app --yes");
  }
  if (command.includes("npm init") && !command.includes("-y")) {
    finalCommand = command + " -y";
  }

  const { spawn } = await import("child_process");

  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", finalCommand], {
      cwd: _ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const stdinInterval = setInterval(() => {
      try { proc.stdin.write("\n"); } catch {}
    }, 1000);

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    // Auto-promote to background task if still running after 10s.
    // Any long-running process (dev servers, watchers, etc.) gets promoted
    // so the agent isn't blocked for the full 2-minute timeout.
    const autoPromoteTimeout = setTimeout(async () => {
      if (settled) return;
      settled = true;
      clearInterval(stdinInterval);
      clearTimeout(timeout);

      // Hand the running process off to the background task manager
      try {
        const { getBackgroundTaskManager } = await import("../tools/background");
        const taskManager = getBackgroundTaskManager(_ctx.workingDirectory);
        const taskId = taskManager.adoptProcess(finalCommand, proc, stdout, stderr);

        hookManager.executeHooks("afterCommand", {
          command: finalCommand, exitCode: null, stdout, stderr,
          duration: Date.now() - startTime, workingDirectory: _ctx.workingDirectory,
        });

        const partialOutput = (stdout + stderr).trim().slice(-500);
        resolve(
          `[STILL RUNNING — promoted to background task]\n` +
          `Task ID: ${taskId}\n` +
          `The command didn't exit within 10s, so it was moved to a background task.\n` +
          `Use background_status("${taskId}") or background_output("${taskId}") to check on it.\n` +
          (partialOutput ? `\nPartial output so far:\n${partialOutput}` : "")
        );
      } catch {
        // Fallback: just kill it
        proc.kill("SIGTERM");
        resolve(`TIMEOUT: Command still running after 10s. Partial output:\n${stdout}\n${stderr}\nTIP: Use background_start for long-running processes.`);
      }
    }, 10000);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(stdinInterval);
      clearTimeout(autoPromoteTimeout);
      proc.kill("SIGTERM");
      hookManager.executeHooks("afterCommand", {
        command: finalCommand, exitCode: -1, stdout, stderr: stderr + "\nTIMEOUT",
        duration: Date.now() - startTime, workingDirectory: _ctx.workingDirectory,
      });
      resolve(`TIMEOUT after 2 min. Partial output:\n${stdout}\n${stderr}\nTIP: Use background_start for long-running processes.`);
    }, 120000);

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(autoPromoteTimeout);
      clearInterval(stdinInterval);
      hookManager.executeHooks("afterCommand", {
        command: finalCommand, exitCode: code ?? 0, stdout, stderr,
        duration: Date.now() - startTime, workingDirectory: _ctx.workingDirectory,
      });
      resolve(code === 0 ? stdout || stderr || "Command completed successfully." : `Exit code ${code}:\n${stdout}\n${stderr}`);
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(autoPromoteTimeout);
      clearInterval(stdinInterval);
      hookManager.executeHooks("onError", {
        command: finalCommand, error: err.message, workingDirectory: _ctx.workingDirectory,
      });
      resolve(`Error: ${err.message}`);
    });
  });
}

// ============================================
// Multi-Agent Orchestration Tools
// ============================================

const spawnAgent = tool({
  description:
    "Spawn a background agent. Use runtime='claude' for complex tasks that need a stronger model, runtime='8gent' for standard tasks, runtime='shell' for simple commands.",
  inputSchema: z.object({
    task: z.string().describe("Task description for the background agent to execute"),
    runtime: z.enum(["8gent", "claude", "shell"]).optional().describe("Runtime to use: '8gent' (default, internal agent), 'claude' (Claude CLI for complex tasks), 'shell' (sh -c for simple commands)"),
    model: z.string().optional().describe("Model to use (only for 8gent runtime)"),
    timeout: z.number().optional().describe("Timeout in ms (default: 5 min, only for claude/shell runtimes)"),
  }),
  execute: async ({ task, runtime, model, timeout }) => {
    try {
      const effectiveRuntime = runtime || "8gent";

      if (effectiveRuntime === "claude" || effectiveRuntime === "shell") {
        const { spawnCLIAgent } = await import("../orchestration");
        const agent = spawnCLIAgent(effectiveRuntime, task, {
          workingDirectory: _ctx.workingDirectory,
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
      const { getAgentPool } = await import("../orchestration");
      const pool = getAgentPool();
      const agent = await pool.spawnAgent(task, {
        model: model || undefined,
        workingDirectory: _ctx.workingDirectory,
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
  },
});

const checkAgent = tool({
  description:
    "Check the status and result of a spawned background agent by ID. Works with all runtimes (8gent, claude, shell). Returns status and result if done.",
  inputSchema: z.object({
    agentId: z.string().describe("Agent ID returned from spawn_agent"),
  }),
  execute: async ({ agentId }) => {
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
  },
});

const listAgents = tool({
  description:
    "List all spawned background agents (8gent, claude, shell) with their status. Shows unified overview across all runtimes.",
  inputSchema: z.object({}),
  execute: async () => {
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
  },
});

// ── Multi-Agent Orchestration Tools ──────────────────────────────

import { getOrchestratorBus } from "../orchestration/orchestrator-bus";
import { getPersona, listPersonas, matchPersona } from "../orchestration/personas";

const suggest_spawn = tool({
  description: "Suggest spawning a specialist sub-agent for a specific task. The user will be asked to approve unless auto-spawn is enabled.",
  parameters: z.object({
    persona: z.string().describe("Persona ID: winston, larry, curly, mo, or doc"),
    task: z.string().describe("The specific task for this agent"),
    reason: z.string().describe("Why this specialist is needed"),
  }),
  execute: async ({ persona, task, reason }) => {
    const p = getPersona(persona);
    if (!p) {
      const available = listPersonas().map(p => `${p.id} (${p.name} - ${p.role})`).join(", ");
      return `Unknown persona "${persona}". Available: ${available}`;
    }

    const bus = getOrchestratorBus();
    const request = bus.requestSpawn(persona, task, reason);

    if (request.autoApproved) {
      return `Auto-approved: Spawning ${p.name} (${p.role}) for: ${task}`;
    }

    return `Spawn request submitted for ${p.name} (${p.role}): ${task}\nReason: ${reason}\nAwaiting user approval...`;
  },
});

const check_agents = tool({
  description: "Check the status of all active sub-agents.",
  parameters: z.object({}),
  execute: async () => {
    const bus = getOrchestratorBus();
    const agents = bus.getAgents();

    if (agents.length === 0) {
      return "No active sub-agents. You are operating solo.";
    }

    const lines = agents.map(a =>
      `${a.persona.icon} ${a.persona.name} (${a.persona.role}) — ${a.status}\n  Task: ${a.task}\n  Since: ${a.spawnedAt.toLocaleTimeString()}`
    );

    return `Active agents (${agents.length}):\n\n${lines.join("\n\n")}`;
  },
});

const message_agent = tool({
  description: "Send a message to a specific sub-agent. Used for coordination between orchestrator and specialists.",
  parameters: z.object({
    agentId: z.string().describe("The agent ID to message"),
    message: z.string().describe("The message content"),
  }),
  execute: async ({ agentId, message }) => {
    const bus = getOrchestratorBus();
    const agent = bus.getAgent(agentId);

    if (!agent) {
      const available = bus.getAgents().map(a => `${a.id} (${a.persona.name})`).join(", ");
      return `Agent "${agentId}" not found. Active agents: ${available || "none"}`;
    }

    bus.routeMessage(agentId, {
      id: `msg-${Date.now()}`,
      role: "system",
      content: `[From Orchestrator] ${message}`,
      agentId: "orchestrator",
      timestamp: new Date(),
    });

    // If the agent has a ref, chat with it
    if (agent.agentRef?.chat) {
      try {
        const response = await agent.agentRef.chat(message);
        return `${agent.persona.name} responded: ${response.slice(0, 500)}`;
      } catch (err) {
        return `${agent.persona.name} encountered an error: ${err instanceof Error ? err.message : err}`;
      }
    }

    return `Message queued for ${agent.persona.name}. Agent may not be ready yet.`;
  },
});

const merge_agent_work = tool({
  description: "Review and merge a sub-agent's worktree changes into the main branch. Only the orchestrator should call this.",
  parameters: z.object({
    agentId: z.string().describe("The agent ID whose work to merge"),
    commitMessage: z.string().optional().describe("Custom merge commit message"),
  }),
  execute: async ({ agentId, commitMessage }) => {
    const bus = getOrchestratorBus();
    const agent = bus.getAgent(agentId);

    if (!agent) {
      return `Agent "${agentId}" not found.`;
    }

    if (!agent.worktreePath) {
      return `Agent "${agentId}" has no worktree to merge.`;
    }

    // Import worktree manager lazily
    const { WorktreeManager } = await import("../orchestration/worktree-manager");
    const wm = new WorktreeManager();

    // Get diff for review
    const changes = await wm.getChanges(agentId);
    if (!changes) {
      bus.updateAgentStatus(agentId, "completed");
      return `${agent.persona.name} made no changes. Marking as completed.`;
    }

    // Merge
    const result = await wm.mergeWorktree(
      agentId,
      commitMessage || `merge(${agent.persona.id}): ${agent.task.slice(0, 60)}`
    );

    if (result.success) {
      bus.updateAgentStatus(agentId, "completed");
      return `Merged ${agent.persona.name}'s work: ${result.message}\n\nChanges:\n${changes.slice(0, 1000)}`;
    }

    return `Merge failed: ${result.message}`;
  },
});

// ============================================
// GitHub Deep Integration (AI SDK wrappers)
// ============================================

const ghIssueView = tool({
  description: "View a GitHub issue with full details: body, labels, assignees, comments, timeline",
  inputSchema: z.object({
    number: z.number().describe("Issue number"),
  }),
  execute: async ({ number }) =>
    runShellCommand(`gh issue view ${number} --json number,title,state,body,author,labels,assignees,milestone,createdAt,updatedAt,closedAt,url,comments`),
});

const ghIssueComment = tool({
  description: "Add a comment to a GitHub issue",
  inputSchema: z.object({
    number: z.number().describe("Issue number"),
    body: z.string().describe("Comment body (markdown)"),
  }),
  execute: async ({ number, body }) =>
    runShellCommand(`gh issue comment ${number} --body "${body}"`),
});

const ghIssueClose = tool({
  description: "Close a GitHub issue. Optionally mark as completed or not-planned",
  inputSchema: z.object({
    number: z.number().describe("Issue number"),
    reason: z.enum(["completed", "not_planned"]).optional().describe("Close reason"),
    comment: z.string().optional().describe("Closing comment"),
  }),
  execute: async ({ number, reason, comment }) => {
    let cmd = `gh issue close ${number}`;
    if (reason) cmd += ` --reason ${reason}`;
    if (comment) cmd += ` --comment "${comment}"`;
    return runShellCommand(cmd);
  },
});

const ghIssueSearch = tool({
  description: "Search issues across the repo using GitHub search syntax",
  inputSchema: z.object({
    query: z.string().describe("Search query (GitHub search syntax)"),
    limit: z.number().optional().describe("Max results (default: 20)"),
  }),
  execute: async ({ query, limit }) =>
    runShellCommand(`gh issue list --search "${query}" --limit ${limit || 20} --json number,title,state,labels,author,createdAt,url`),
});

const ghIssueAssign = tool({
  description: "Assign users to a GitHub issue",
  inputSchema: z.object({
    number: z.number().describe("Issue number"),
    assignees: z.string().describe("Comma-separated GitHub usernames"),
  }),
  execute: async ({ number, assignees }) =>
    runShellCommand(`gh issue edit ${number} --add-assignee ${assignees}`),
});

const ghIssueLabel = tool({
  description: "Add labels to a GitHub issue",
  inputSchema: z.object({
    number: z.number().describe("Issue number"),
    labels: z.string().describe("Comma-separated label names"),
  }),
  execute: async ({ number, labels }) =>
    runShellCommand(`gh issue edit ${number} --add-label "${labels}"`),
});

const ghPrReview = tool({
  description: "Submit a review on a PR: approve, request-changes, or comment",
  inputSchema: z.object({
    number: z.number().describe("PR number"),
    action: z.enum(["approve", "request-changes", "comment"]).describe("Review action"),
    body: z.string().optional().describe("Review body"),
  }),
  execute: async ({ number, action, body }) => {
    let cmd = `gh pr review ${number} --${action}`;
    if (body) cmd += ` --body "${body}"`;
    return runShellCommand(cmd);
  },
});

const ghPrMerge = tool({
  description: "Merge a pull request. Supports merge, squash, or rebase",
  inputSchema: z.object({
    number: z.number().describe("PR number"),
    method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method (default: squash)"),
    deleteBranch: z.boolean().optional().describe("Delete branch after merge (default: true)"),
  }),
  execute: async ({ number, method, deleteBranch }) => {
    let cmd = `gh pr merge ${number} --${method || "squash"}`;
    if (deleteBranch !== false) cmd += " --delete-branch";
    return runShellCommand(cmd);
  },
});

const ghPrDiff = tool({
  description: "Get the full diff of a pull request for code review",
  inputSchema: z.object({
    number: z.number().describe("PR number"),
  }),
  execute: async ({ number }) => runShellCommand(`gh pr diff ${number}`),
});

const ghPrChecks = tool({
  description: "View CI/CD check status for a PR",
  inputSchema: z.object({
    number: z.number().describe("PR number"),
  }),
  execute: async ({ number }) => runShellCommand(`gh pr checks ${number}`),
});

const ghPrComment = tool({
  description: "Add a comment to a pull request",
  inputSchema: z.object({
    number: z.number().describe("PR number"),
    body: z.string().describe("Comment body (markdown)"),
  }),
  execute: async ({ number, body }) =>
    runShellCommand(`gh pr comment ${number} --body "${body}"`),
});

const ghWorkflowList = tool({
  description: "List GitHub Actions workflows",
  inputSchema: z.object({}),
  execute: async () => runShellCommand("gh workflow list"),
});

const ghWorkflowRun = tool({
  description: "Trigger a GitHub Actions workflow_dispatch event",
  inputSchema: z.object({
    workflow: z.string().describe("Workflow name or filename"),
    ref: z.string().optional().describe("Branch or tag"),
  }),
  execute: async ({ workflow, ref }) => {
    let cmd = `gh workflow run "${workflow}"`;
    if (ref) cmd += ` --ref ${ref}`;
    return runShellCommand(cmd);
  },
});

const ghRunList = tool({
  description: "List recent GitHub Actions workflow runs",
  inputSchema: z.object({
    workflow: z.string().optional().describe("Filter by workflow"),
    status: z.string().optional().describe("Filter by status: completed, in_progress, failure, success"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  }),
  execute: async ({ workflow, status, limit }) => {
    let cmd = `gh run list --limit ${limit || 10} --json databaseId,workflowName,status,conclusion,headBranch,event,createdAt,url`;
    if (workflow) cmd += ` --workflow "${workflow}"`;
    if (status) cmd += ` --status ${status}`;
    return runShellCommand(cmd);
  },
});

const ghRunView = tool({
  description: "View a specific workflow run with job details",
  inputSchema: z.object({
    runId: z.number().describe("Run ID"),
  }),
  execute: async ({ runId }) =>
    runShellCommand(`gh run view ${runId} --json databaseId,workflowName,status,conclusion,jobs,headBranch,event,createdAt,url`),
});

const ghRunLog = tool({
  description: "View logs for a workflow run",
  inputSchema: z.object({
    runId: z.number().describe("Run ID"),
    failed: z.boolean().optional().describe("Only show failed steps"),
  }),
  execute: async ({ runId, failed }) =>
    runShellCommand(failed ? `gh run view ${runId} --log-failed` : `gh run view ${runId} --log`),
});

const ghRunRerun = tool({
  description: "Re-run a workflow. Can re-run only failed jobs",
  inputSchema: z.object({
    runId: z.number().describe("Run ID"),
    failedOnly: z.boolean().optional().describe("Only re-run failed jobs"),
  }),
  execute: async ({ runId, failedOnly }) =>
    runShellCommand(failedOnly ? `gh run rerun ${runId} --failed` : `gh run rerun ${runId}`),
});

const ghGistCreate = tool({
  description: "Create a GitHub gist from files",
  inputSchema: z.object({
    files: z.string().describe("Space-separated file paths"),
    description: z.string().optional().describe("Gist description"),
    public: z.boolean().optional().describe("Make public (default: secret)"),
  }),
  execute: async ({ files, description, public: isPublic }) => {
    let cmd = `gh gist create ${files}`;
    if (description) cmd += ` --desc "${description}"`;
    if (isPublic) cmd += " --public";
    return runShellCommand(cmd);
  },
});

const ghGistList = tool({
  description: "List your GitHub gists",
  inputSchema: z.object({
    limit: z.number().optional().describe("Max gists (default: 10)"),
  }),
  execute: async ({ limit }) => runShellCommand(`gh gist list --limit ${limit || 10}`),
});

const ghGistView = tool({
  description: "View a gist's content",
  inputSchema: z.object({
    id: z.string().describe("Gist ID or URL"),
  }),
  execute: async ({ id }) => runShellCommand(`gh gist view ${id} --raw`),
});

const ghReleaseList = tool({
  description: "List GitHub releases",
  inputSchema: z.object({
    limit: z.number().optional().describe("Max releases (default: 10)"),
  }),
  execute: async ({ limit }) => runShellCommand(`gh release list --limit ${limit || 10}`),
});

const ghReleaseCreate = tool({
  description: "Create a GitHub release with tag, title, and notes",
  inputSchema: z.object({
    tag: z.string().describe("Release tag (e.g., v1.0.0)"),
    title: z.string().optional().describe("Release title"),
    notes: z.string().optional().describe("Release notes (markdown)"),
    draft: z.boolean().optional().describe("Create as draft"),
    prerelease: z.boolean().optional().describe("Mark as pre-release"),
    generateNotes: z.boolean().optional().describe("Auto-generate notes from commits"),
  }),
  execute: async ({ tag, title, notes, draft, prerelease, generateNotes }) => {
    let cmd = `gh release create ${tag}`;
    if (title) cmd += ` --title "${title}"`;
    if (notes) cmd += ` --notes "${notes}"`;
    if (draft) cmd += " --draft";
    if (prerelease) cmd += " --prerelease";
    if (generateNotes) cmd += " --generate-notes";
    return runShellCommand(cmd);
  },
});

const ghReleaseView = tool({
  description: "View a specific release with body, assets, and metadata",
  inputSchema: z.object({
    tag: z.string().describe("Release tag (e.g., v1.0.0 or 'latest')"),
  }),
  execute: async ({ tag }) => runShellCommand(`gh release view ${tag}`),
});

const ghProjectList = tool({
  description: "List GitHub Projects v2",
  inputSchema: z.object({
    owner: z.string().optional().describe("GitHub user or org"),
  }),
  execute: async ({ owner }) => {
    let cmd = "gh project list";
    if (owner) cmd += ` --owner ${owner}`;
    return runShellCommand(cmd);
  },
});

const ghProjectItems = tool({
  description: "List items in a GitHub Project with status and linked issues/PRs",
  inputSchema: z.object({
    number: z.number().describe("Project number"),
    owner: z.string().optional().describe("Project owner"),
  }),
  execute: async ({ number, owner }) => {
    let cmd = `gh project item-list ${number} --limit 30`;
    if (owner) cmd += ` --owner ${owner}`;
    return runShellCommand(cmd);
  },
});

const ghNotifications = tool({
  description: "View GitHub notifications: PR reviews, issue mentions, CI failures",
  inputSchema: z.object({
    limit: z.number().optional().describe("Max notifications (default: 20)"),
  }),
  execute: async ({ limit }) =>
    runShellCommand(`gh api notifications?per_page=${limit || 20} --jq '.[] | "\\(.reason) | \\(.subject.type) | \\(.repository.full_name) | \\(.subject.title)"'`),
});

const ghRepoView = tool({
  description: "View repo info: description, stars, forks, language, topics",
  inputSchema: z.object({
    repo: z.string().optional().describe("Repository (owner/name). Omit for current."),
  }),
  execute: async ({ repo }) =>
    runShellCommand(`gh repo view ${repo || ""} --json name,owner,description,url,stargazerCount,forkCount,primaryLanguage,isPrivate,defaultBranchRef,repositoryTopics`),
});

const ghSearchCode = tool({
  description: "Search code across GitHub repositories",
  inputSchema: z.object({
    query: z.string().describe("Search query (GitHub code search syntax)"),
    repo: z.string().optional().describe("Limit to specific repo"),
    language: z.string().optional().describe("Filter by language"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  }),
  execute: async ({ query, repo, language, limit }) => {
    let cmd = `gh search code "${query}" --limit ${limit || 10}`;
    if (repo) cmd += ` --repo ${repo}`;
    if (language) cmd += ` --language ${language}`;
    return runShellCommand(cmd);
  },
});

const ghSearchRepos = tool({
  description: "Search GitHub repositories by name, description, topics, stars",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    language: z.string().optional().describe("Filter by language"),
    sort: z.string().optional().describe("Sort: stars, forks, updated"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  }),
  execute: async ({ query, language, sort, limit }) => {
    let cmd = `gh search repos "${query}" --limit ${limit || 10}`;
    if (language) cmd += ` --language ${language}`;
    if (sort) cmd += ` --sort ${sort}`;
    return runShellCommand(cmd);
  },
});

const ghBranchCompare = tool({
  description: "Compare two branches: commits ahead/behind, files changed",
  inputSchema: z.object({
    base: z.string().describe("Base branch (e.g., main)"),
    head: z.string().optional().describe("Head branch (default: current)"),
  }),
  execute: async ({ base, head }) => {
    const ref = head || "HEAD";
    return runShellCommand(`git log --oneline ${base}..${ref} && echo "---" && git diff --stat ${base}...${ref}`);
  },
});

const ghRepoHealth = tool({
  description: "Repo health check: open issues/PRs, CI status, stale branches, branch protection",
  inputSchema: z.object({}),
  execute: async () => {
    const issues = await runShellCommand("gh issue list --state open --json number --jq '. | length'");
    const prs = await runShellCommand("gh pr list --state open --json number --jq '. | length'");
    const ci = await runShellCommand("gh run list --limit 1 --json status,conclusion,workflowName");
    return `Open issues: ${issues}\nOpen PRs: ${prs}\nLatest CI: ${ci}`;
  },
});

const ghTriage = tool({
  description: "Triage dashboard: PRs needing review, unlabeled issues, failed CI",
  inputSchema: z.object({}),
  execute: async () => {
    const prs = await runShellCommand("gh pr list --state open --json number,title,author,reviewDecision,url");
    const failedCI = await runShellCommand("gh run list --status failure --limit 5 --json databaseId,workflowName,headBranch,url");
    return `PRs:\n${prs}\n\nFailed CI:\n${failedCI}`;
  },
});

const ghLabelList = tool({
  description: "List all labels in the repository",
  inputSchema: z.object({}),
  execute: async () => runShellCommand("gh label list --json name,description,color"),
});

const ghLabelCreate = tool({
  description: "Create a new label",
  inputSchema: z.object({
    name: z.string().describe("Label name"),
    color: z.string().optional().describe("Hex color without # (e.g., ff0000)"),
    description: z.string().optional().describe("Label description"),
  }),
  execute: async ({ name, color, description }) => {
    let cmd = `gh label create "${name}"`;
    if (color) cmd += ` --color ${color}`;
    if (description) cmd += ` --description "${description}"`;
    return runShellCommand(cmd);
  },
});

const ghSyncFork = tool({
  description: "Sync a forked repo with its upstream",
  inputSchema: z.object({
    branch: z.string().optional().describe("Branch to sync"),
  }),
  execute: async ({ branch }) => {
    let cmd = "gh repo sync";
    if (branch) cmd += ` --branch ${branch}`;
    return runShellCommand(cmd);
  },
});

// ============================================
// Composed ToolSet
// ============================================

/**
 * All 8gent tools in AI SDK format.
 * Pass this directly to generateText() or streamText().
 */
export const agentTools = {
  // Code exploration
  get_outline: getOutline,
  get_symbol: getSymbol,
  search_symbols: searchSymbols,

  // File operations
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  list_files: listFiles,

  // Git
  git_status: gitStatus,
  git_diff: gitDiff,
  git_log: gitLog,
  git_add: gitAdd,
  git_commit: gitCommit,
  git_push: gitPush,
  git_branch: gitBranch,
  git_checkout: gitCheckout,
  git_create_branch: gitCreateBranch,

  // GitHub CLI (basic)
  gh_pr_list: ghPrList,
  gh_pr_create: ghPrCreate,
  gh_pr_view: ghPrView,
  gh_issue_list: ghIssueList,
  gh_issue_create: ghIssueCreate,

  // GitHub Issues (deep)
  gh_issue_view: ghIssueView,
  gh_issue_comment: ghIssueComment,
  gh_issue_close: ghIssueClose,
  gh_issue_search: ghIssueSearch,
  gh_issue_assign: ghIssueAssign,
  gh_issue_label: ghIssueLabel,

  // GitHub PRs (deep)
  gh_pr_review: ghPrReview,
  gh_pr_merge: ghPrMerge,
  gh_pr_diff: ghPrDiff,
  gh_pr_checks: ghPrChecks,
  gh_pr_comment: ghPrComment,

  // GitHub Actions
  gh_workflow_list: ghWorkflowList,
  gh_workflow_run: ghWorkflowRun,
  gh_run_list: ghRunList,
  gh_run_view: ghRunView,
  gh_run_log: ghRunLog,
  gh_run_rerun: ghRunRerun,

  // GitHub Gists
  gh_gist_create: ghGistCreate,
  gh_gist_list: ghGistList,
  gh_gist_view: ghGistView,

  // GitHub Releases
  gh_release_list: ghReleaseList,
  gh_release_create: ghReleaseCreate,
  gh_release_view: ghReleaseView,

  // GitHub Projects
  gh_project_list: ghProjectList,
  gh_project_items: ghProjectItems,

  // GitHub Repo & Search
  gh_repo_view: ghRepoView,
  gh_search_code: ghSearchCode,
  gh_search_repos: ghSearchRepos,
  gh_notifications: ghNotifications,
  gh_label_list: ghLabelList,
  gh_label_create: ghLabelCreate,

  // GitHub Branches & Sync
  gh_branch_compare: ghBranchCompare,
  gh_repo_health: ghRepoHealth,
  gh_triage: ghTriage,
  gh_sync_fork: ghSyncFork,

  // Shell
  run_command: runCommand,

  // LSP
  lsp_goto_definition: lspGotoDefinition,
  lsp_find_references: lspFindReferences,
  lsp_hover: lspHover,
  lsp_document_symbols: lspDocumentSymbols,

  // Image
  read_image: readImage,
  describe_image: describeImage,

  // PDF
  read_pdf: readPdf,
  read_pdf_page: readPdfPage,

  // Notebook
  read_notebook: readNotebook,
  notebook_edit_cell: notebookEditCell,
  notebook_insert_cell: notebookInsertCell,
  notebook_delete_cell: notebookDeleteCell,

  // Web
  web_search: webSearchTool,
  web_fetch: webFetchTool,

  // MCP
  mcp_list_tools: mcpListTools,
  mcp_call_tool: mcpCallTool,

  // Background tasks
  background_start: backgroundStart,
  background_status: backgroundStatus,
  background_output: backgroundOutput,

  // Multi-agent orchestration
  spawn_agent: spawnAgent,
  check_agent: checkAgent,
  list_agents: listAgents,

  // Multi-agent orchestration (persona-based)
  suggest_spawn,
  check_agents,
  message_agent,
  merge_agent_work,
} satisfies ToolSet;

export type AgentTools = typeof agentTools;
