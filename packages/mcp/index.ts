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
export type {
	ServerConfig,
	StdioServerConfig,
	SSEServerConfig,
} from "./config";

export { StdioTransport, SSETransport } from "./transport";
export type { Transport } from "./transport";

export { bridgeTools, mcpToolKey, parseMcpToolKey } from "./tool-bridge";
export type { MCPToolSchema } from "./tool-bridge";

export { MCPServer, startMCPServer } from "./server";

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
 * Server text is untrusted: cap it, then replace control and bidi characters
 * (keeping newlines and tabs unless oneLine) before it is printed or shown.
 */
export function clean(value: unknown, max: number, oneLine = false): string {
	const s = String(value ?? "").slice(0, max);
	const out = s.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
		/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g,
		"?",
	);
	return oneLine ? out.replace(/[\n\t]+/g, " ") : out;
}

/**
 * Format MCP tool result as string for agent consumption.
 */
export function formatToolResult(result: {
	content: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
}): string {
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
