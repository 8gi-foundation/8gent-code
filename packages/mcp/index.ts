/**
 * 8gent Code - MCP (Model Context Protocol) Client
 *
 * Connects to MCP servers to extend 8gent with external tools.
 * Reference: https://github.com/modelcontextprotocol/servers
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";

// ============================================
// Types
// ============================================

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPConfig {
  mcpServers?: Record<string, Omit<MCPServerConfig, "name">>;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ============================================
// MCP Client
// ============================================

export class MCPClient {
  private servers: Map<string, {
    config: MCPServerConfig;
    process: ChildProcess | null;
    tools: MCPTool[];
    requestId: number;
    pendingRequests: Map<number, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>;
    buffer: string;
  }> = new Map();

  /**
   * Load MCP configuration from ~/.8gent/mcp.json
   */
  async loadConfig(): Promise<MCPConfig> {
    const configPath = path.join(os.homedir(), ".8gent", "mcp.json");

    if (!fs.existsSync(configPath)) {
      // Return empty config if file doesn't exist
      return { mcpServers: {} };
    }

    try {
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content) as MCPConfig;
    } catch (err) {
      console.error(`[mcp] Error loading config: ${err}`);
      return { mcpServers: {} };
    }
  }

  /**
   * Start all configured MCP servers
   */
  async startServers(): Promise<void> {
    const config = await this.loadConfig();

    if (!config.mcpServers) {
      return;
    }

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      await this.startServer({
        name,
        ...serverConfig,
      });
    }
  }

  /**
   * Start a specific MCP server
   */
  async startServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      console.log(`[mcp] Server '${config.name}' already running`);
      return;
    }

    console.log(`[mcp] Starting server: ${config.name}`);

    const serverState = {
      config,
      process: null as ChildProcess | null,
      tools: [] as MCPTool[],
      requestId: 0,
      pendingRequests: new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }>(),
      buffer: "",
    };

    this.servers.set(config.name, serverState);

    try {
      // Spawn the MCP server process
      const env = {
        ...process.env,
        ...config.env,
      };

      const proc = spawn(config.command, config.args || [], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      serverState.process = proc;

      // Handle stdout (JSON-RPC responses)
      proc.stdout.on("data", (data) => {
        serverState.buffer += data.toString();
        this.processBuffer(config.name);
      });

      // Handle stderr (logging)
      proc.stderr.on("data", (data) => {
        console.error(`[mcp:${config.name}] ${data.toString().trim()}`);
      });

      // Handle process exit
      proc.on("close", (code) => {
        console.log(`[mcp] Server '${config.name}' exited with code ${code}`);
        this.servers.delete(config.name);
      });

      proc.on("error", (err) => {
        console.error(`[mcp] Server '${config.name}' error: ${err.message}`);
        this.servers.delete(config.name);
      });

      // Initialize the server
      await this.initializeServer(config.name);

      // Get available tools
      await this.refreshTools(config.name);

      console.log(`[mcp] Server '${config.name}' started with ${serverState.tools.length} tools`);
    } catch (err) {
      console.error(`[mcp] Failed to start server '${config.name}': ${err}`);
      this.servers.delete(config.name);
    }
  }

  /**
   * Process buffered data for JSON-RPC messages
   */
  private processBuffer(serverName: string): void {
    const server = this.servers.get(serverName);
    if (!server) return;

    // Split by newlines and process complete JSON messages
    const lines = server.buffer.split("\n");
    server.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const response = JSON.parse(trimmed) as JSONRPCResponse;

        if (response.id !== undefined) {
          const pending = server.pendingRequests.get(response.id);
          if (pending) {
            server.pendingRequests.delete(response.id);
            if (response.error) {
              pending.reject(new Error(response.error.message));
            } else {
              pending.resolve(response.result);
            }
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }
  }

  /**
   * Send a JSON-RPC request to a server
   */
  private async sendRequest(serverName: string, method: string, params?: unknown): Promise<unknown> {
    const server = this.servers.get(serverName);
    if (!server || !server.process) {
      throw new Error(`Server '${serverName}' not running`);
    }

    const id = ++server.requestId;
    const request: JSONRPCRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      server.pendingRequests.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        server.pendingRequests.delete(id);
        reject(new Error(`Request timeout for method '${method}'`));
      }, 30000);

      server.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      try {
        server.process!.stdin.write(JSON.stringify(request) + "\n");
      } catch (err) {
        server.pendingRequests.delete(id);
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * Initialize a server (MCP handshake)
   */
  private async initializeServer(serverName: string): Promise<void> {
    await this.sendRequest(serverName, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        roots: { listChanged: true },
      },
      clientInfo: {
        name: "8gent-code",
        version: "0.1.0",
      },
    });

    // Send initialized notification
    const server = this.servers.get(serverName);
    if (server?.process) {
      server.process.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n");
    }
  }

  /**
   * Refresh the list of tools from a server
   */
  async refreshTools(serverName: string): Promise<MCPTool[]> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server '${serverName}' not found`);
    }

    try {
      const result = await this.sendRequest(serverName, "tools/list") as { tools: MCPTool[] };
      server.tools = result.tools || [];
      return server.tools;
    } catch (err) {
      console.error(`[mcp] Failed to list tools from '${serverName}': ${err}`);
      return [];
    }
  }

  /**
   * List all tools from all servers
   */
  listTools(): { server: string; tool: MCPTool }[] {
    const allTools: { server: string; tool: MCPTool }[] = [];

    for (const [serverName, server] of this.servers) {
      for (const tool of server.tools) {
        allTools.push({ server: serverName, tool });
      }
    }

    return allTools;
  }

  /**
   * Get tools from a specific server
   */
  getServerTools(serverName: string): MCPTool[] {
    const server = this.servers.get(serverName);
    return server?.tools || [];
  }

  /**
   * Call a tool on a specific server
   */
  async callTool(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<MCPToolResult> {
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`Server '${serverName}' not found`);
    }

    const tool = server.tools.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Tool '${toolName}' not found on server '${serverName}'`);
    }

    try {
      const result = await this.sendRequest(serverName, "tools/call", {
        name: toolName,
        arguments: args || {},
      }) as MCPToolResult;

      return result;
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error calling tool: ${err}`,
        }],
        isError: true,
      };
    }
  }

  /**
   * Stop a specific server
   */
  stopServer(serverName: string): void {
    const server = this.servers.get(serverName);
    if (server?.process) {
      server.process.kill("SIGTERM");
      this.servers.delete(serverName);
      console.log(`[mcp] Server '${serverName}' stopped`);
    }
  }

  /**
   * Stop all servers
   */
  stopAll(): void {
    for (const serverName of this.servers.keys()) {
      this.stopServer(serverName);
    }
  }

  /**
   * Get list of running servers
   */
  getRunningServers(): string[] {
    return [...this.servers.keys()];
  }

  /**
   * Check if a server is running
   */
  isServerRunning(serverName: string): boolean {
    return this.servers.has(serverName);
  }
}

// ============================================
// Singleton Instance
// ============================================

let mcpClientInstance: MCPClient | null = null;

export function getMCPClient(): MCPClient {
  if (!mcpClientInstance) {
    mcpClientInstance = new MCPClient();
  }
  return mcpClientInstance;
}

export function resetMCPClient(): void {
  if (mcpClientInstance) {
    mcpClientInstance.stopAll();
    mcpClientInstance = null;
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Load MCP config from the default location
 */
export async function loadMCPConfig(): Promise<MCPConfig> {
  const client = getMCPClient();
  return client.loadConfig();
}

/**
 * Format MCP tool result as string for agent consumption
 */
export function formatToolResult(result: MCPToolResult): string {
  const parts: string[] = [];

  for (const content of result.content) {
    if (content.type === "text" && content.text) {
      parts.push(content.text);
    } else if (content.type === "image" && content.data) {
      parts.push(`[Image: ${content.mimeType || "image/unknown"}]`);
    } else if (content.type === "resource") {
      parts.push(`[Resource: ${JSON.stringify(content)}]`);
    }
  }

  return parts.join("\n");
}
