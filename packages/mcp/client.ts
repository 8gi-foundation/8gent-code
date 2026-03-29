/**
 * MCP Client Orchestrator
 *
 * Manages connections to multiple MCP servers, discovers tools,
 * and provides a unified interface for the agent to use.
 */

import type { ToolSet } from "ai";
import { loadConfig, type ServerConfig, type StdioServerConfig, type SSEServerConfig } from "./config";
import { StdioTransport, SSETransport, type Transport } from "./transport";
import { bridgeTools, type MCPToolSchema } from "./tool-bridge";

// ── Types ────────────────────────────────────────────────────────

interface ServerConnection {
  config: ServerConfig;
  transport: Transport;
  tools: MCPToolSchema[];
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

// ── Client ───────────────────────────────────────────────────────

export class MCPClient {
  private servers = new Map<string, ServerConnection>();
  private configPath?: string;

  constructor(configPath?: string) {
    this.configPath = configPath;
  }

  /**
   * Connect to all configured MCP servers.
   * Performs handshake + tool discovery on each.
   */
  async connect(): Promise<void> {
    const configs = loadConfig(this.configPath);
    if (configs.length === 0) return;

    const results = await Promise.allSettled(
      configs.map(cfg => this._connectServer(cfg))
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        console.error(`[mcp] Failed to connect "${configs[i].name}": ${r.reason}`);
      }
    }
  }

  private async _connectServer(config: ServerConfig): Promise<void> {
    let transport: Transport;

    if (config.type === "stdio") {
      const stdio = new StdioTransport(config.command, config.args, config.env);
      await stdio.start();
      transport = stdio;
    } else {
      transport = new SSETransport(config.url, config.headers);
    }

    // MCP handshake
    await transport.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: "8gent-code", version: "1.0.0" },
    });

    transport.notify("notifications/initialized");

    // Discover tools
    const result = await transport.send("tools/list") as { tools: MCPToolSchema[] };
    const tools = result?.tools || [];

    this.servers.set(config.name, { config, transport, tools });

    console.log(`[mcp] Connected to "${config.name}" - ${tools.length} tools`);
  }

  /**
   * Get all MCP tools as AI SDK ToolSet entries.
   * Merges tools from all connected servers.
   */
  getTools(): ToolSet {
    const merged: ToolSet = {};

    for (const [name, conn] of this.servers) {
      const bridged = bridgeTools(name, conn.tools, this);
      Object.assign(merged, bridged);
    }

    return merged;
  }

  /**
   * Call a tool on a specific server.
   * Used by the tool-bridge execute callbacks.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    const conn = this.servers.get(serverName);
    if (!conn) {
      return {
        content: [{ type: "text", text: `Server "${serverName}" not connected` }],
        isError: true,
      };
    }

    try {
      const result = await conn.transport.send("tools/call", {
        name: toolName,
        arguments: args || {},
      }) as MCPToolResult;

      return result;
    } catch (err) {
      return {
        content: [{ type: "text", text: `MCP tool error: ${err}` }],
        isError: true,
      };
    }
  }

  /**
   * List all connected servers and their tool counts.
   */
  listServers(): Array<{ name: string; toolCount: number; type: string }> {
    return [...this.servers.entries()].map(([name, conn]) => ({
      name,
      toolCount: conn.tools.length,
      type: conn.config.type,
    }));
  }

  /**
   * Check if any servers are connected.
   */
  isConnected(): boolean {
    return this.servers.size > 0;
  }

  /**
   * Shutdown all server connections.
   */
  close(): void {
    for (const [name, conn] of this.servers) {
      try {
        conn.transport.close();
      } catch {
        // Best-effort cleanup
      }
    }
    this.servers.clear();
  }
}
