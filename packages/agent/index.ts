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

const DEFAULT_SYSTEM_PROMPT = `You are 8gent, a powerful AI coding assistant running locally on the user's machine.

You have access to tools for exploring and modifying codebases efficiently. ALWAYS use these tools instead of asking the user to run commands.

## Available Tools

1. **get_outline** - Get all symbols (functions, classes, types) in a file WITHOUT reading the full content. Use this FIRST to understand file structure.
   Arguments: { "filePath": "path/to/file.ts" }

2. **get_symbol** - Get the source code for a specific symbol. Much more efficient than reading entire files.
   Arguments: { "symbolId": "path/to/file.ts::functionName" }

3. **search_symbols** - Search for symbols across the codebase by name or signature.
   Arguments: { "query": "searchTerm", "kinds": ["function", "class"] }

4. **read_file** - Read a file's contents. Use get_outline + get_symbol when possible instead.
   Arguments: { "path": "path/to/file" }

5. **write_file** - Write content to a file.
   Arguments: { "path": "path/to/file", "content": "file content" }

6. **run_command** - Execute a shell command.
   Arguments: { "command": "npm test" }

## Efficiency Guidelines

- ALWAYS use get_outline before reading files to understand structure
- Use get_symbol to retrieve specific functions instead of reading entire files
- This saves tokens and makes you faster
- Be direct and helpful. No unnecessary explanations.

## Response Format

When using tools, respond with a JSON tool call:
\`\`\`json
{"tool": "tool_name", "arguments": {...}}
\`\`\`

When done with a task, respond naturally to the user.`;

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
      case "get_outline":
        return this.getOutline(args.filePath as string);

      case "get_symbol":
        return this.getSymbol(args.symbolId as string);

      case "search_symbols":
        return this.searchSymbols(args.query as string, args.kinds as string[]);

      case "read_file":
        return this.readFile(args.path as string);

      case "write_file":
        return this.writeFile(args.path as string, args.content as string);

      case "run_command":
        return this.runCommand(args.command as string);

      case "list_files":
        return this.listFiles(args.path as string, args.pattern as string);

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

  private async runCommand(command: string): Promise<string> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDirectory,
        timeout: 30000,
      });
      return stdout || stderr || "Command completed successfully.";
    } catch (err: any) {
      return `Error: ${err.message}\n${err.stderr || ""}`;
    }
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
    const maxTurns = this.config.maxTurns || 10;

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

        // Add assistant message and tool result
        this.messages.push({ role: "assistant", content });
        this.messages.push({ role: "tool", content: result, toolCallId: toolCall.id });

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
    // Look for JSON tool call in response
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
        // Not valid JSON
      }
    }

    // Try raw JSON
    try {
      const parsed = JSON.parse(content.trim());
      if (parsed.tool) {
        return {
          id: Date.now().toString(),
          name: parsed.tool,
          arguments: parsed.arguments || {},
        };
      }
    } catch {
      // Not JSON
    }

    return null;
  }

  async isReady(): Promise<boolean> {
    return this.client.isAvailable();
  }

  clearHistory(): void {
    this.messages = [this.messages[0]]; // Keep system prompt
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
    model: config?.model || savedConfig.model || "qwen2.5-coder:7b",
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
Commands:
  /help     - Show this help
  /clear    - Clear conversation history
  /quit     - Exit 8gent

Tips:
  - Ask to explore code: "What functions are in src/index.ts?"
  - Ask to modify code: "Add error handling to the login function"
  - Ask to run tests: "Run the test suite"
`);
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
  startREPL();
}
