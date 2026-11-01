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
import { MCPRPCError, SSETransport, StdioTransport, type Transport } from "./transport";

// ── Types ────────────────────────────────────────────────────────

interface ServerConnection {
	config: ServerConfig;
	transport: Transport;
	tools: MCPToolSchema[];
	/** Started again after its server exited (#3542). */
	restarted?: boolean;
	/** Answered a tools/call since it started. */
	answered?: boolean;
	era: Era;
	protocolVersion: string;
}

/**
 * Protocol eras (#3549). Legacy: the 2024-11-05 `initialize` handshake.
 * Modern: 2026-07-28, no handshake, version and capabilities in every
 * request's `_meta`. EIGHT_MCP_MODERN=1 probes modern first and falls back.
 */
type Era = "modern" | "legacy";
const LEGACY_VERSION = "2024-11-05";
const MODERN_VERSION = "2026-07-28";
const CLIENT_INFO = { name: "8gent-code", version: "1.0.0" };
/** Spec-defined modern error codes: HeaderMismatch, MissingRequiredClientCapability, UnsupportedProtocolVersion. */
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);

function modernMeta(): Record<string, unknown> {
	return {
		"io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
		"io.modelcontextprotocol/clientInfo": CLIENT_INFO,
		"io.modelcontextprotocol/clientCapabilities": {},
	};
}

/** Add modern `_meta` to request params; legacy params are untouched. */
function withMeta(
	era: Era,
	params: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
	if (era === "legacy") return Object.keys(params).length ? params : undefined;
	return { ...params, _meta: { ...modernMeta(), ...(params._meta as object) } };
}

/** A modern result with a resultType other than "complete" is one we cannot act on. */
function complete<T>(era: Era, result: T): T {
	if (era === "legacy") return result;
	const type = (result as { resultType?: unknown } | null)?.resultType;
	if (type !== undefined && type !== "complete")
		throw new Error(
			`MCP server returned resultType "${String(type)}", which 8gent does not support`,
		);
	return result;
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
	/** Bumped by close(), so a connect still in its handshake knows to discard itself. */
	private generation = 0;
	private configPath?: string;
	private probeTimeoutMs: number;

	constructor(configPath?: string, opts: { probeTimeoutMs?: number } = {}) {
		this.configPath = configPath;
		this.probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
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
		const gen = this.generation;
		let transport: Transport;

		if (config.type === "stdio") {
			const stdio = new StdioTransport(config.command, config.args, config.env);
			await stdio.start();
			transport = stdio;
		} else {
			transport = new SSETransport(config.url, config.headers);
		}

		let tools: MCPToolSchema[];
		let era: Era = "legacy";
		try {
			if (process.env.EIGHT_MCP_MODERN === "1") era = await this._probe(transport);

			if (era === "legacy") {
				// MCP handshake
				await transport.send("initialize", {
					protocolVersion: LEGACY_VERSION,
					capabilities: { roots: { listChanged: true } },
					clientInfo: CLIENT_INFO,
				});

				transport.notify("notifications/initialized");
			}

			// Discover tools
			const result = complete(
				era,
				(await transport.send("tools/list", withMeta(era))) as {
					tools: MCPToolSchema[];
				},
			);
			tools = result?.tools || [];
		} catch (err) {
			// A server that fails the handshake is not kept, so it must not keep running.
			transport.close();
			throw err;
		}

		// close() ran while this server was starting: it must not outlive the client.
		if (gen !== this.generation) {
			transport.close();
			throw new Error("client closed while connecting");
		}

		const protocolVersion = era === "modern" ? MODERN_VERSION : LEGACY_VERSION;
		const conn: ServerConnection = { config, transport, tools, era, protocolVersion };
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
		const gen = this.generation;
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
					if (gen !== this.generation) return undefined; // client closed meanwhile
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
	 * Detect the server's era, per the 2026-07-28 lifecycle page: send
	 * `server/discover` with our modern version. A DiscoverResult or a
	 * recognised modern error means modern (never fall back then), except an
	 * UnsupportedProtocolVersion error or DiscoverResult that lists 2024-11-05,
	 * which means the handshake. Any other error, a non-discover result, or no
	 * answer in time means legacy.
	 * Decided once per connection, which is the server process on stdio.
	 */
	private async _probe(transport: Transport): Promise<Era> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.probeTimeoutMs);
		});
		let answer: unknown;
		try {
			answer = await Promise.race([transport.send("server/discover", withMeta("modern")), timeout]);
		} catch (err) {
			if (!(err instanceof MCPRPCError) || !MODERN_ERRORS.has(err.code)) return "legacy";
			const supported = (err.data as { supported?: unknown } | undefined)?.supported;
			// UnsupportedProtocolVersion that lists the version we also speak: use it.
			if (err.code === -32022 && Array.isArray(supported) && supported.includes(LEGACY_VERSION))
				return "legacy";
			throw new Error(
				`MCP server speaks the ${MODERN_VERSION}+ protocol but refused our request (${err.message}${
					Array.isArray(supported) ? `; it supports ${supported.join(", ")}` : ""
				}); 8gent speaks ${MODERN_VERSION} and ${LEGACY_VERSION}`,
			);
		} finally {
			clearTimeout(timer);
		}
		const versions = (answer as { supportedVersions?: unknown } | null)?.supportedVersions;
		if (!Array.isArray(versions)) return "legacy";
		if (versions.includes(MODERN_VERSION)) return "modern";
		if (versions.includes(LEGACY_VERSION)) return "legacy";
		throw new Error(
			`MCP server supports ${versions.join(", ")}; 8gent speaks ${MODERN_VERSION} and ${LEGACY_VERSION}`,
		);
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
			const result = (await conn.transport.send(
				"tools/call",
				withMeta(conn.era, { name: toolName, arguments: args || {} }),
			)) as MCPToolResult;
			conn.answered = true;

			return complete(conn.era, result);
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
	listServers(): Array<{
		name: string;
		toolCount: number;
		type: string;
		era: Era;
		protocolVersion: string;
	}> {
		return this._live().map(([name, conn]) => ({
			name,
			toolCount: conn.tools.length,
			type: conn.config.type,
			era: conn.era,
			protocolVersion: conn.protocolVersion,
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
		this.generation++;
	}
}
