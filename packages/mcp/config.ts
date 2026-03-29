/**
 * MCP Config Loader
 *
 * Loads and validates MCP server configuration from ~/.8gent/mcp.json.
 * Supports both stdio (command + args) and SSE (url) server configs.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Types ────────────────────────────────────────────────────────

export interface StdioServerConfig {
  type: "stdio";
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SSEServerConfig {
  type: "sse";
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | SSEServerConfig;

export interface MCPConfigFile {
  servers?: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
  // Legacy format compat
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

// ── Loader ───────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".8gent", "mcp.json");

export function loadConfig(configPath?: string): ServerConfig[] {
  const filePath = configPath || DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: MCPConfigFile = JSON.parse(raw);
    return parseConfig(parsed);
  } catch (err) {
    console.error(`[mcp] Error loading config from ${filePath}: ${err}`);
    return [];
  }
}

function parseConfig(config: MCPConfigFile): ServerConfig[] {
  const results: ServerConfig[] = [];

  // New format: { servers: { ... } }
  const servers = config.servers || config.mcpServers || {};

  for (const [name, entry] of Object.entries(servers)) {
    if (entry.url) {
      results.push({
        type: "sse",
        name,
        url: entry.url,
        headers: entry.headers,
      } as SSEServerConfig);
    } else if (entry.command) {
      results.push({
        type: "stdio",
        name,
        command: entry.command,
        args: entry.args,
        env: entry.env,
      });
    } else {
      console.error(`[mcp] Server "${name}" needs either "command" or "url"`);
    }
  }

  return results;
}
