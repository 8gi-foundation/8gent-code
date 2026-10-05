/**
 * MCP Client Orchestrator
 *
 * Manages connections to multiple MCP servers, discovers tools,
 * and provides a unified interface for the agent to use.
 */

import type { ToolSet } from "ai";
import {
	type SSEServerConfig,
	type ServerConfig,
	type StdioServerConfig,
	loadConfig,
} from "./config";
import { type MCPToolSchema, bridgeTools } from "./tool-bridge";
import { SSETransport, StdioTransport, type Transport } from "./transport";

// ── Types ────────────────────────────────────────────────────────

interface ServerConnection {
	config: ServerConfig;
	transport: Transport;
	tools: MCPToolSchema[];
	/** Started again after its server exited (#3542). */
	restarted?: boolean;
	/** Answered a tools/call since it started. */
	answered?: boolean;
}

/** The server behind this connection has exited; its tools cannot run. */
const dead = (conn: ServerConnection) => conn.transport.closed === true;

export interface MCPToolResult {
	content: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	isError?: boolean;
}

function stopped(name: string, err?: unknown): MCPToolResult {
	const detail = err ? ` (${err})` : "";
	return {
		content: [
			{
				type: "text",
				text: `MCP server "${name}" stopped and could not be restarted; its tools are no longer available${detail}`,
			},
		],
		isError: true,
	};
}

// ── Client ───────────────────────────────────────────────────────

export class MCPClient {
	private servers = new Map<string, ServerConnection>();
	/** One restart in flight per server, shared by every caller that found it dead. */
	private reviving = new Map<string, Promise<ServerConnection | undefined>>();
	private configPath?: string;

	constructor(configPath?: string) {
		this.configPath = configPath;
	}

	/** The servers this client's config file names, read now. */
	loadServerConfigs(): ServerConfig[] {
		return loadConfig(this.configPath);
	}

	/**
	 * Connect to all configured MCP servers, or exactly the given ones (the
	 * approved list, so nothing re-reads the config after the card).
	 * Performs handshake + tool discovery on each.
	 */
	async connect(only?: ServerConfig[]): Promise<void> {
		const configs = only ?? loadConfig(this.configPath);
		if (configs.length === 0) return;

		const results = await Promise.allSettled(configs.map((cfg) => this._connectServer(cfg)));

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.status === "rejected") {
				console.error(`[mcp] Failed to connect "${configs[i].name}": ${r.reason}`);
			}
		}
	}

	private async _connectServer(config: ServerConfig): Promise<ServerConnection> {
		let transport: Transport;

		if (config.type === "stdio") {
			const stdio = new StdioTransport(config.command, config.args, config.env);
			await stdio.start();
			transport = stdio;
		} else {
			transport = new SSETransport(config.url, config.headers);
		}

		let tools: MCPToolSchema[];
		try {
			// MCP handshake
			await transport.send("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: { roots: { listChanged: true } },
				clientInfo: { name: "8gent-code", version: "1.0.0" },
			});

			transport.notify("notifications/initialized");

			// Discover tools
			const result = (await transport.send("tools/list")) as {
				tools: MCPToolSchema[];
			};
			tools = result?.tools || [];
		} catch (err) {
			// A server that fails the handshake is not kept, so it must not keep running.
			transport.close();
			throw err;
		}

		const conn: ServerConnection = { config, transport, tools };
		const prev = this.servers.get(config.name);
		this.servers.set(config.name, conn);
		// A replaced connection must not keep its server running.
		if (prev) {
			try {
				prev.transport.close();
			} catch {}
		}

		console.log(`[mcp] Connected to "${config.name}" - ${tools.length} tools`);
		return conn;
	}

	/**
	 * Start a server whose process exited, once, from the config it was approved
	 * with (no re-read of the file), refreshing its tools. A server that cannot
	 * start, or was already restarted and died again before answering a call,
	 * is removed so its tools stop being offered.
	 */
	private _revive(name: string, conn: ServerConnection): Promise<ServerConnection | undefined> {
		const inflight = this.reviving.get(name);
		if (inflight) return inflight;
		const p = (async () => {
			const current = this.servers.get(name);
			if (current !== conn) return current; // already restarted or removed
			let why = "it exited again before answering a call";
			if (!conn.restarted || conn.answered) {
				try {
					const fresh = await this._connectServer(conn.config);
					fresh.restarted = true;
					return fresh;
				} catch (err) {
					why = `restart failed: ${err}`;
				}
			}
			if (this.servers.get(name) === conn) this.servers.delete(name);
			console.error(`[mcp] Server "${name}" stopped and was removed (${why})`);
			return undefined;
		})().finally(() => this.reviving.delete(name));
		this.reviving.set(name, p);
		return p;
	}

	/** Connections whose server is still running. */
	private _live(): Array<[string, ServerConnection]> {
		return [...this.servers.entries()].filter(([, conn]) => !dead(conn));
	}

	/**
	 * Get all MCP tools as AI SDK ToolSet entries.
	 * Merges tools from all connected servers.
	 */
	getTools(): ToolSet {
		const merged: ToolSet = {};

		for (const [name, conn] of this._live()) {
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
		let conn = this.servers.get(serverName);
		if (!conn) {
			return {
				content: [{ type: "text", text: `Server "${serverName}" not connected` }],
				isError: true,
			};
		}
		// Exited before this call was sent: start it again, then send.
		if (dead(conn)) {
			conn = await this._revive(serverName, conn);
			if (!conn) return stopped(serverName);
		}

		try {
			const result = (await conn.transport.send("tools/call", {
				name: toolName,
				arguments: args || {},
			})) as MCPToolResult;
			conn.answered = true;

			return result;
		} catch (err) {
			// Exited during the call: it may have acted, so the call is not sent
			// again, but the server is started for the next one (or removed).
			if (dead(conn) && !(await this._revive(serverName, conn))) {
				return stopped(serverName, err);
			}
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
		return this._live().map(([name, conn]) => ({
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

	/** @deprecated Use listServers() */
	getRunningServers(): string[] {
		return this.listServers().map((s) => s.name);
	}

	/** @deprecated Use listServers() for counts, getTools() for merged ToolSet */
	getServerTools(serverName: string): MCPToolSchema[] {
		return this.servers.get(serverName)?.tools ?? [];
	}

	/** @deprecated Use getTools() which returns a ToolSet */
	listTools(): Array<{ server: string; tool: MCPToolSchema }> {
		const result: Array<{ server: string; tool: MCPToolSchema }> = [];
		for (const [name, conn] of this._live()) {
			for (const tool of conn.tools) {
				result.push({ server: name, tool });
			}
		}
		return result;
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
