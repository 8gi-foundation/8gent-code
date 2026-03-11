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
5. Execute ONE tool at a time. Wait for result before next tool.
6. If a tool fails twice, SKIP IT and continue with next step.

WRONG: "Here's the code..." or "You can create..."
RIGHT: "PLAN: 1) create app 2) add pages 3) commit" then {"tool": "run_command", ...}

## Tool Format

Output ONLY this JSON to use a tool:
\`\`\`json
{"tool": "TOOL_NAME", "arguments": {"key": "value"}}
\`\`\`

## Code Exploration (AST-first for efficiency)
- get_outline: List functions/classes in file
  {"tool": "get_outline", "arguments": {"filePath": "src/index.ts"}}
- get_symbol: Get one function's source
  {"tool": "get_symbol", "arguments": {"symbolId": "src/index.ts::myFunc"}}
- search_symbols: Find symbols by name
  {"tool": "search_symbols", "arguments": {"query": "handleError"}}

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
2. ONE STEP AT A TIME. Complete and verify each step before next.
3. VERIFY SUCCESS. Use list_files or read_file after creating files.
4. FAIL FAST. If step fails twice, skip and continue.
5. COMMIT OFTEN. git_add + git_commit after each feature.
6. Prefer bun over npm/npx for speed.
7. NEVER output code blocks. Use write_file tool.
8. Use get_outline before reading full files (saves tokens).

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

  constructor(workingDirectory: string = process.cwd()) {
    this.workingDirectory = workingDirectory;
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
        resolve(`TIMEOUT after 2 min. Partial output:\n${stdout}\n${stderr}\nTIP: Try bun instead of npx, or add --yes flag.`);
      }, 120000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        clearInterval(stdinInterval);
        if (code === 0) {
          resolve(stdout || stderr || "Command completed successfully.");
        } else {
          resolve(`Exit code ${code}:\n${stdout}\n${stderr}`);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        clearInterval(stdinInterval);
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
}

// ============================================
// Agent
// ============================================

export class Agent {
  private client: OllamaClient;
  private executor: ToolExecutor;
  private messages: Message[] = [];
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.client = new OllamaClient(config.model);
    this.executor = new ToolExecutor(config.workingDirectory || process.cwd());

    // Initialize with system prompt
    this.messages.push({
      role: "system",
      content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    });
  }

  async chat(userMessage: string): Promise<string> {
    this.messages.push({ role: "user", content: userMessage });

    let turns = 0;
    const maxTurns = this.config.maxTurns || 20; // Increased for complex scaffolding tasks

    while (turns < maxTurns) {
      turns++;

      // Get response from model
      const response = await this.client.chat(this.messages);
      const content = response.message.content;

      // Check for tool calls in the response
      const toolCall = this.parseToolCall(content);

      if (toolCall) {
        // Execute the tool
        console.log(`\n🔧 ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 50)}...)`);
        const result = await this.executor.execute(toolCall.name, toolCall.arguments);

        // Add assistant message with tool call
        this.messages.push({ role: "assistant", content });

        // Add tool result as a user message (Ollama understands user/assistant, not tool)
        this.messages.push({
          role: "user",
          content: `[Tool Result for ${toolCall.name}]:\n${result}\n\nNow respond to the user based on this result. Do NOT call the same tool again.`,
        });

        // Continue loop to process tool result
        continue;
      } else {
        // No tool call, return the response
        this.messages.push({ role: "assistant", content });
        return content;
      }
    }

    return "Max turns reached. Please try a simpler request.";
  }

  private parseToolCall(content: string): ToolCall | null {
    // Method 1: Look for simple tool call pattern {"tool": "name", "arguments": {...}}
    // This handles inline JSON
    const simpleMatch = content.match(/\{"tool"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]+\})\s*\}/);
    if (simpleMatch) {
      try {
        return {
          id: Date.now().toString(),
          name: simpleMatch[1],
          arguments: JSON.parse(simpleMatch[2]),
        };
      } catch {
        // Arguments parsing failed
      }
    }

    // Method 2: Extract tool name and arguments separately for complex content
    const toolMatch = content.match(/"tool"\s*:\s*"(\w+)"/);
    const argsMatch = content.match(/"arguments"\s*:\s*\{([^]*?)\}\s*\}/);

    if (toolMatch && toolMatch[1]) {
      const toolName = toolMatch[1];
      let args: Record<string, unknown> = {};

      // Special handling for write_file with multiline content
      if (toolName === "write_file") {
        const pathMatch = content.match(/"path"\s*:\s*"([^"]+)"/);
        // For content, extract everything between "content": and the closing
        const contentMatch = content.match(/"content"\s*:\s*[`"]([\s\S]*?)[`"]\s*\}/);
        if (pathMatch) {
          args = {
            path: pathMatch[1],
            content: contentMatch ? contentMatch[1] : "",
          };
        }
      } else if (argsMatch) {
        try {
          args = JSON.parse(`{${argsMatch[1]}}`);
        } catch {
          // Try to extract individual args
          const commandMatch = content.match(/"command"\s*:\s*"([^"]+)"/);
          if (commandMatch) args = { command: commandMatch[1] };
        }
      }

      return {
        id: Date.now().toString(),
        name: toolName,
        arguments: args,
      };
    }

    // Method 3: Code fence with clean JSON
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.tool) {
          return {
            id: Date.now().toString(),
            name: parsed.tool,
            arguments: parsed.arguments || {},
          };
        }
      } catch {
        // Not valid JSON, try the extraction method above
      }
    }

    return null;
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

\x1b[33mTips:\x1b[0m
  - Ask to explore code: "What functions are in src/index.ts?"
  - Ask to build something: "Build a React component for..."
  - Ask to fix code: "Fix the bug in the login function"
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
