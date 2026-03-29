/**
 * 8gent Code - LSP Integration
 *
 * Language Server Protocol client for code intelligence.
 * Supports: typescript-language-server, pyright, rust-analyzer
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";

// ============================================
// Types
// ============================================

interface LSPMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface Position {
  line: number;      // 0-indexed
  character: number; // 0-indexed
}

interface Range {
  start: Position;
  end: Position;
}

interface Location {
  uri: string;
  range: Range;
}

interface TextDocumentIdentifier {
  uri: string;
}

interface TextDocumentPositionParams {
  textDocument: TextDocumentIdentifier;
  position: Position;
}

interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

interface Hover {
  contents: string | { language: string; value: string } | Array<string | { language: string; value: string }>;
  range?: Range;
}

interface Diagnostic {
  range: Range;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

const SEVERITY_MAP: Record<number, string> = {
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};

// Symbol kind mapping from LSP spec
const SYMBOL_KIND_MAP: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

// ============================================
// LSP Server Configuration
// ============================================

interface LSPServerConfig {
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
}

const LSP_SERVERS: Record<string, LSPServerConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    initializationOptions: {
      preferences: {
        includeInlayParameterNameHints: "all",
        includeInlayPropertyDeclarationTypeHints: true,
        includeInlayFunctionLikeReturnTypeHints: true,
      },
    },
  },
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    initializationOptions: {},
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    initializationOptions: {
      checkOnSave: { command: "clippy" },
    },
  },
};

// ============================================
// LSP Client
// ============================================

export class LSPClient {
  private process: ChildProcess | null = null;
  private language: string;
  private workspaceRoot: string;
  private messageId: number = 0;
  private pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private buffer: string = "";
  private initialized: boolean = false;
  private openDocuments: Set<string> = new Set();
  private diagnosticWaiters: Map<string, (diags: Diagnostic[]) => void> = new Map();

  constructor(language: string, workspaceRoot: string) {
    this.language = language;
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /**
   * Start the LSP server process
   */
  async start(): Promise<void> {
    const config = LSP_SERVERS[this.language];
    if (!config) {
      throw new Error(`Unsupported language: ${this.language}. Supported: ${Object.keys(LSP_SERVERS).join(", ")}`);
    }

    // Check if the server command exists
    const serverExists = await this.checkServerExists(config.command);
    if (!serverExists) {
      throw new Error(`LSP server '${config.command}' not found. Install it first:\n` +
        this.getInstallInstructions(this.language));
    }

    this.process = spawn(config.command, config.args, {
      cwd: this.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.handleData(data);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      // Log errors but don't fail
      console.error(`[LSP ${this.language}] stderr:`, data.toString());
    });

    this.process.on("error", (err) => {
      console.error(`[LSP ${this.language}] process error:`, err);
    });

    this.process.on("exit", (code) => {
      console.log(`[LSP ${this.language}] exited with code ${code}`);
      this.initialized = false;
    });

    // Initialize the server
    await this.initialize(config.initializationOptions);
  }

  /**
   * Stop the LSP server
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    // Send shutdown request
    try {
      await this.sendRequest("shutdown", null);
      this.sendNotification("exit", null);
    } catch {
      // Ignore errors during shutdown
    }

    this.process.kill();
    this.process = null;
    this.initialized = false;
    this.openDocuments.clear();
  }

  /**
   * Go to definition for a symbol at position
   */
  async goToDefinition(filePath: string, line: number, character: number): Promise<Location[] | null> {
    await this.ensureDocumentOpen(filePath);

    const params: TextDocumentPositionParams = {
      textDocument: { uri: this.pathToUri(filePath) },
      position: { line, character },
    };

    const result = await this.sendRequest("textDocument/definition", params);
    return this.normalizeLocations(result);
  }

  /**
   * Find all references to a symbol
   */
  async findReferences(filePath: string, line: number, character: number, includeDeclaration: boolean = true): Promise<Location[] | null> {
    await this.ensureDocumentOpen(filePath);

    const params = {
      textDocument: { uri: this.pathToUri(filePath) },
      position: { line, character },
      context: { includeDeclaration },
    };

    const result = await this.sendRequest("textDocument/references", params);
    return this.normalizeLocations(result);
  }

  /**
   * Get hover information for a symbol
   */
  async hover(filePath: string, line: number, character: number): Promise<string | null> {
    await this.ensureDocumentOpen(filePath);

    const params: TextDocumentPositionParams = {
      textDocument: { uri: this.pathToUri(filePath) },
      position: { line, character },
    };

    const result = await this.sendRequest("textDocument/hover", params) as Hover | null;
    if (!result) return null;

    return this.formatHoverContent(result.contents);
  }

  /**
   * Get document symbols (outline)
   */
  async documentSymbols(filePath: string): Promise<Array<{ name: string; kind: string; range: Range; children?: unknown[] }> | null> {
    await this.ensureDocumentOpen(filePath);

    const params = {
      textDocument: { uri: this.pathToUri(filePath) },
    };

    const result = await this.sendRequest("textDocument/documentSymbol", params);
    if (!result) return null;

    // Result can be DocumentSymbol[] or SymbolInformation[]
    if (Array.isArray(result) && result.length > 0) {
      if ("range" in result[0]) {
        // DocumentSymbol format
        return (result as DocumentSymbol[]).map(sym => this.formatDocumentSymbol(sym));
      } else if ("location" in result[0]) {
        // SymbolInformation format
        return (result as SymbolInformation[]).map(sym => ({
          name: sym.name,
          kind: SYMBOL_KIND_MAP[sym.kind] || "Unknown",
          range: sym.location.range,
        }));
      }
    }

    return null;
  }

  /**
   * Get diagnostics for a file (errors, warnings)
   * LSP publishes diagnostics via notifications, so we open/change the doc
   * and collect the next publishDiagnostics notification.
   */
  async diagnostics(filePath: string): Promise<Diagnostic[]> {
    await this.ensureDocumentOpen(filePath);

    return new Promise<Diagnostic[]>((resolve) => {
      const uri = this.pathToUri(filePath);
      const handler = (diags: Diagnostic[]) => resolve(diags);
      this.diagnosticWaiters.set(uri, handler);

      // Re-send didChange to trigger fresh diagnostics
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.workspaceRoot, filePath);
      const content = fs.readFileSync(absolutePath, "utf-8");
      this.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }],
      });

      // Timeout - return empty if server doesn't respond in 5s
      setTimeout(() => {
        if (this.diagnosticWaiters.has(uri)) {
          this.diagnosticWaiters.delete(uri);
          resolve([]);
        }
      }, 5000);
    });
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.process !== null && this.initialized;
  }

  // ============================================
  // Private Methods
  // ============================================

  private async initialize(options?: Record<string, unknown>): Promise<void> {
    const params = {
      processId: process.pid,
      rootUri: this.pathToUri(this.workspaceRoot),
      rootPath: this.workspaceRoot,
      capabilities: {
        textDocument: {
          synchronization: {
            openClose: true,
            change: 1, // Full sync
          },
          hover: {
            contentFormat: ["markdown", "plaintext"],
          },
          definition: {
            linkSupport: true,
          },
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      workspaceFolders: [
        {
          uri: this.pathToUri(this.workspaceRoot),
          name: path.basename(this.workspaceRoot),
        },
      ],
      initializationOptions: options,
    };

    await this.sendRequest("initialize", params);
    this.sendNotification("initialized", {});
    this.initialized = true;
  }

  private async ensureDocumentOpen(filePath: string): Promise<void> {
    const uri = this.pathToUri(filePath);
    if (this.openDocuments.has(uri)) return;

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workspaceRoot, filePath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`File not found: ${absolutePath}`);
    }

    const content = fs.readFileSync(absolutePath, "utf-8");
    const languageId = this.getLanguageId(absolutePath);

    this.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });

    this.openDocuments.add(uri);

    // Give the server a moment to process
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("LSP server not running"));
        return;
      }

      const id = ++this.messageId;
      const message: LSPMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      const content = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

      this.process.stdin.write(header + content);

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timed out: ${method}`));
        }
      }, 10000);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin) return;

    const message: LSPMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

    this.process.stdin.write(header + content);
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) break;

      const messageStr = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      try {
        const message: LSPMessage = JSON.parse(messageStr);
        this.handleMessage(message);
      } catch (e) {
        console.error("[LSP] Failed to parse message:", e);
      }
    }
  }

  private handleMessage(message: LSPMessage): void {
    // Handle responses to our requests
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    }

    // Handle server-initiated notifications
    if (message.method === "textDocument/publishDiagnostics" && message.params) {
      const params = message.params as { uri: string; diagnostics: Diagnostic[] };
      const waiter = this.diagnosticWaiters.get(params.uri);
      if (waiter) {
        this.diagnosticWaiters.delete(params.uri);
        waiter(params.diagnostics || []);
      }
    }
  }

  private pathToUri(filePath: string): string {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.workspaceRoot, filePath);
    return `file://${absolutePath}`;
  }

  private uriToPath(uri: string): string {
    if (uri.startsWith("file://")) {
      return uri.slice(7);
    }
    return uri;
  }

  private normalizeLocations(result: unknown): Location[] | null {
    if (!result) return null;

    if (Array.isArray(result)) {
      return result.map(loc => ({
        uri: this.uriToPath(loc.uri || loc.targetUri),
        range: loc.range || loc.targetRange,
      }));
    }

    if (typeof result === "object" && result !== null) {
      const loc = result as Location & { targetUri?: string; targetRange?: Range };
      return [{
        uri: this.uriToPath(loc.uri || loc.targetUri || ""),
        range: loc.range || loc.targetRange || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      }];
    }

    return null;
  }

  private formatHoverContent(contents: Hover["contents"]): string {
    if (typeof contents === "string") {
      return contents;
    }

    if (Array.isArray(contents)) {
      return contents.map(c => {
        if (typeof c === "string") return c;
        return c.value;
      }).join("\n\n");
    }

    if (typeof contents === "object" && "value" in contents) {
      return contents.value;
    }

    return JSON.stringify(contents);
  }

  private formatDocumentSymbol(sym: DocumentSymbol): { name: string; kind: string; range: Range; children?: unknown[] } {
    return {
      name: sym.name,
      kind: SYMBOL_KIND_MAP[sym.kind] || "Unknown",
      range: sym.range,
      children: sym.children?.map(child => this.formatDocumentSymbol(child)),
    };
  }

  private getLanguageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".py": "python",
      ".rs": "rust",
      ".go": "go",
    };
    return langMap[ext] || "plaintext";
  }

  private async checkServerExists(command: string): Promise<boolean> {
    const { execSync } = await import("child_process");
    try {
      execSync(`which ${command}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private getInstallInstructions(language: string): string {
    const instructions: Record<string, string> = {
      typescript: "npm install -g typescript-language-server typescript",
      python: "pip install pyright",
      rust: "rustup component add rust-analyzer",
    };
    return instructions[language] || "Install the appropriate language server";
  }
}

// ============================================
// LSP Manager (Singleton for managing clients)
// ============================================

class LSPManager {
  private clients: Map<string, LSPClient> = new Map();

  /**
   * Get or create an LSP client for a language
   */
  async getClient(language: string, workspaceRoot: string): Promise<LSPClient> {
    const key = `${language}:${workspaceRoot}`;

    let client = this.clients.get(key);
    if (client?.isRunning()) {
      return client;
    }

    // Create new client
    client = new LSPClient(language, workspaceRoot);
    await client.start();
    this.clients.set(key, client);

    return client;
  }

  /**
   * Stop all clients
   */
  async stopAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.stop();
    }
    this.clients.clear();
  }

  /**
   * Get language from file extension
   */
  getLanguageForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "typescript",
      ".jsx": "typescript",
      ".py": "python",
      ".rs": "rust",
    };
    return langMap[ext] || null;
  }
}

// Singleton instance
let managerInstance: LSPManager | null = null;

export function getLSPManager(): LSPManager {
  if (!managerInstance) {
    managerInstance = new LSPManager();
  }
  return managerInstance;
}

// ============================================
// Convenience Functions
// ============================================

/**
 * Go to definition helper
 */
export async function lspGoToDefinition(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot: string = process.cwd()
): Promise<string> {
  const manager = getLSPManager();
  const language = manager.getLanguageForFile(filePath);

  if (!language) {
    return `Unsupported file type: ${path.extname(filePath)}`;
  }

  try {
    const client = await manager.getClient(language, workspaceRoot);
    const locations = await client.goToDefinition(filePath, line, character);

    if (!locations || locations.length === 0) {
      return "No definition found";
    }

    return locations.map(loc =>
      `${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
    ).join("\n");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Find references helper
 */
export async function lspFindReferences(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot: string = process.cwd()
): Promise<string> {
  const manager = getLSPManager();
  const language = manager.getLanguageForFile(filePath);

  if (!language) {
    return `Unsupported file type: ${path.extname(filePath)}`;
  }

  try {
    const client = await manager.getClient(language, workspaceRoot);
    const locations = await client.findReferences(filePath, line, character);

    if (!locations || locations.length === 0) {
      return "No references found";
    }

    return `Found ${locations.length} references:\n` +
      locations.map(loc =>
        `  ${loc.uri}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
      ).join("\n");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Hover helper
 */
export async function lspHover(
  filePath: string,
  line: number,
  character: number,
  workspaceRoot: string = process.cwd()
): Promise<string> {
  const manager = getLSPManager();
  const language = manager.getLanguageForFile(filePath);

  if (!language) {
    return `Unsupported file type: ${path.extname(filePath)}`;
  }

  try {
    const client = await manager.getClient(language, workspaceRoot);
    const hover = await client.hover(filePath, line, character);

    return hover || "No hover information available";
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Document symbols helper
 */
export async function lspDocumentSymbols(
  filePath: string,
  workspaceRoot: string = process.cwd()
): Promise<string> {
  const manager = getLSPManager();
  const language = manager.getLanguageForFile(filePath);

  if (!language) {
    return `Unsupported file type: ${path.extname(filePath)}`;
  }

  try {
    const client = await manager.getClient(language, workspaceRoot);
    const symbols = await client.documentSymbols(filePath);

    if (!symbols || symbols.length === 0) {
      return "No symbols found";
    }

    function formatSymbol(sym: { name: string; kind: string; range: Range; children?: unknown[] }, indent: number = 0): string {
      const prefix = "  ".repeat(indent);
      let result = `${prefix}${sym.kind}: ${sym.name} (line ${sym.range.start.line + 1})`;
      if (sym.children && Array.isArray(sym.children)) {
        for (const child of sym.children) {
          result += "\n" + formatSymbol(child as { name: string; kind: string; range: Range; children?: unknown[] }, indent + 1);
        }
      }
      return result;
    }

    return symbols.map(s => formatSymbol(s)).join("\n");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Diagnostics helper - get errors/warnings for a file
 */
export async function lspDiagnostics(
  filePath: string,
  workspaceRoot: string = process.cwd()
): Promise<string> {
  const manager = getLSPManager();
  const language = manager.getLanguageForFile(filePath);

  if (!language) {
    return `Unsupported file type: ${path.extname(filePath)}`;
  }

  try {
    const client = await manager.getClient(language, workspaceRoot);
    const diags = await client.diagnostics(filePath);

    if (!diags || diags.length === 0) {
      return "No diagnostics (clean)";
    }

    return `Found ${diags.length} diagnostic(s):\n` +
      diags.map(d =>
        `  [${SEVERITY_MAP[d.severity || 1]}] line ${d.range.start.line + 1}: ${d.message}${d.source ? ` (${d.source})` : ""}`
      ).join("\n");
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Auto-detect which language server to use based on project config files.
 * Returns the language key or null if no server matches.
 */
export function detectLanguageServer(projectRoot: string): string | null {
  if (fs.existsSync(path.join(projectRoot, "tsconfig.json")) ||
      fs.existsSync(path.join(projectRoot, "package.json"))) {
    return "typescript";
  }
  if (fs.existsSync(path.join(projectRoot, "pyproject.toml")) ||
      fs.existsSync(path.join(projectRoot, "setup.py")) ||
      fs.existsSync(path.join(projectRoot, "pyrightconfig.json"))) {
    return "python";
  }
  if (fs.existsSync(path.join(projectRoot, "Cargo.toml"))) {
    return "rust";
  }
  return null;
}
