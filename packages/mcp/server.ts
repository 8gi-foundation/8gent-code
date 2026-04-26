/**
 * 8gent Code - MCP Server
 *
 * Exposes 8gent tools to external MCP clients via JSON-RPC over stdio.
 * This lets any MCP-compatible client (Claude Code, Cursor, etc.) use
 * 8gent's tools: file ops, git, memory, search, PDF, browser, etc.
 *
 * Usage:
 *   8gent mcp-server              # start stdio server
 *   8gent mcp-server --tools=all  # expose all tools (default)
 *   8gent mcp-server --tools=safe # expose read-only tools
 */

import { ToolExecutor } from "../eight/tools";

// ── Types ───────────────────────────────────────────────────────

interface JSONRPCRequest {
	jsonrpc: "2.0";
	id?: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface JSONRPCResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface MCPToolSchema {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

// ── Safe tools (read-only, no side effects) ─────────────────────

const SAFE_TOOLS = new Set([
	"get_outline",
	"get_symbol",
	"search_symbols",
	"get_project_outline",
	"read_file",
	"list_files",
	"git_status",
	"git_diff",
	"git_log",
	"read_pdf",
	"read_pdf_page",
	"search_pdf",
	"recall",
	"web_search",
	"web_fetch",
]);

// ── Server ──────────────────────────────────────────────────────

export class MCPServer {
	private executor: ToolExecutor;
	private toolFilter: "all" | "safe";
	private buffer = "";

	constructor(
		options: { workingDirectory?: string; tools?: "all" | "safe" } = {},
	) {
		this.executor = new ToolExecutor(options.workingDirectory || process.cwd());
		this.toolFilter = options.tools || "all";
	}

	/**
	 * Start listening on stdin for JSON-RPC requests.
	 * Responses are written to stdout.
	 */
	async start(): Promise<void> {
		process.stderr.write("[mcp-server] 8gent MCP server starting on stdio\n");

		const decoder = new TextDecoder();
		const reader = Bun.stdin.stream().getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.buffer += decoder.decode(value, { stream: true });
				await this.processBuffer();
			}
		} catch {
			// stdin closed
		}

		process.stderr.write("[mcp-server] stdin closed, shutting down\n");
	}

	private async processBuffer(): Promise<void> {
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			try {
				const req = JSON.parse(trimmed) as JSONRPCRequest;
				const response = await this.handleRequest(req);
				if (response) {
					this.respond(response);
				}
			} catch (err) {
				this.respond({
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				});
			}
		}
	}

	private respond(response: JSONRPCResponse): void {
		process.stdout.write(JSON.stringify(response) + "\n");
	}

	private async handleRequest(
		req: JSONRPCRequest,
	): Promise<JSONRPCResponse | null> {
		// Notifications (no id) don't get responses
		if (req.id === undefined) return null;

		switch (req.method) {
			case "initialize":
				return this.handleInitialize(req);
			case "tools/list":
				return this.handleToolsList(req);
			case "tools/call":
				return this.handleToolsCall(req);
			case "resources/list":
				return {
					jsonrpc: "2.0",
					id: req.id,
					result: { resources: [] },
				};
			case "prompts/list":
				return {
					jsonrpc: "2.0",
					id: req.id,
					result: { prompts: [] },
				};
			default:
				return {
					jsonrpc: "2.0",
					id: req.id,
					error: { code: -32601, message: `Method not found: ${req.method}` },
				};
		}
	}

	private handleInitialize(req: JSONRPCRequest): JSONRPCResponse {
		return {
			jsonrpc: "2.0",
			id: req.id!,
			result: {
				protocolVersion: "2024-11-05",
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
				},
				serverInfo: {
					name: "8gent-code",
					version: "0.9.0",
				},
			},
		};
	}

	private handleToolsList(req: JSONRPCRequest): JSONRPCResponse {
		const allDefs = this.executor.getToolDefinitions() as Array<{
			type: string;
			function: {
				name: string;
				description: string;
				parameters: {
					type: string;
					properties: Record<string, unknown>;
					required?: string[];
				};
			};
		}>;

		const tools: MCPToolSchema[] = allDefs
			.filter((d) => {
				if (this.toolFilter === "safe") return SAFE_TOOLS.has(d.function.name);
				return true;
			})
			.map((d) => ({
				name: d.function.name,
				description: d.function.description,
				inputSchema: {
					type: "object" as const,
					properties: d.function.parameters.properties || {},
					required: d.function.parameters.required,
				},
			}));

		return {
			jsonrpc: "2.0",
			id: req.id!,
			result: { tools },
		};
	}

	private async handleToolsCall(req: JSONRPCRequest): Promise<JSONRPCResponse> {
		const params = req.params as
			| { name: string; arguments?: Record<string, unknown> }
			| undefined;
		if (!params?.name) {
			return {
				jsonrpc: "2.0",
				id: req.id!,
				error: { code: -32602, message: "Missing tool name" },
			};
		}

		// Check safe filter
		if (this.toolFilter === "safe" && !SAFE_TOOLS.has(params.name)) {
			return {
				jsonrpc: "2.0",
				id: req.id!,
				error: {
					code: -32602,
					message: `Tool "${params.name}" not available in safe mode`,
				},
			};
		}

		try {
			const result = await this.executor.execute(
				params.name,
				params.arguments || {},
			);
			return {
				jsonrpc: "2.0",
				id: req.id!,
				result: {
					content: [
						{
							type: "text",
							text:
								typeof result === "string" ? result : JSON.stringify(result),
						},
					],
				},
			};
		} catch (err) {
			return {
				jsonrpc: "2.0",
				id: req.id!,
				result: {
					content: [{ type: "text", text: `Error: ${err}` }],
					isError: true,
				},
			};
		}
	}
}

// ── CLI entry point ─────────────────────────────────────────────

export async function startMCPServer(args: string[] = []): Promise<void> {
	const tools = args.includes("--tools=safe")
		? ("safe" as const)
		: ("all" as const);
	const cwd = args.find((a) => a.startsWith("--cwd="))?.slice(6);

	const server = new MCPServer({
		workingDirectory: cwd || process.cwd(),
		tools,
	});

	await server.start();
}
