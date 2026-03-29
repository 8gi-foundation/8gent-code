/**
 * 8gent Code - MCP (Model Context Protocol) Client
 *
 * Connects to MCP servers to extend 8gent with external tools.
 * Reference: https://github.com/modelcontextprotocol/servers
 *
 * Phase 1 architecture:
 *   config.ts      - Config loader (~/.8gent/mcp.json)
 *   transport.ts   - StdioTransport + SSETransport
 *   tool-bridge.ts - MCP tools -> Vercel AI SDK tool() bridge
 *   client.ts      - MCPClient orchestrator
 */

// ── New modular API (Phase 1) ────────────────────────────────────

export { MCPClient } from "./client";
export type { MCPToolResult } from "./client";

export { loadConfig } from "./config";
export type { ServerConfig, StdioServerConfig, SSEServerConfig } from "./config";

export { StdioTransport, SSETransport } from "./transport";
export type { Transport } from "./transport";

export { bridgeTools, mcpToolKey, parseMcpToolKey } from "./tool-bridge";
export type { MCPToolSchema } from "./tool-bridge";

// ── Singleton for backward compat ────────────────────────────────

import { MCPClient } from "./client";

let _instance: MCPClient | null = null;

export function getMCPClient(): MCPClient {
  if (!_instance) {
    _instance = new MCPClient();
  }
  return _instance;
}

export function resetMCPClient(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

// ── Legacy helpers ───────────────────────────────────────────────

/**
 * Format MCP tool result as string for agent consumption.
 */
export function formatToolResult(result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }): string {
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
