/**
 * MCP Transport Abstraction
 *
 * Two transports:
 * - StdioTransport: spawn a process, JSON-RPC over stdin/stdout
 * - SSETransport: fetch-based SSE connection to an HTTP MCP endpoint
 */

import { type Subprocess, spawn } from "bun";

// ── Interface ────────────────────────────────────────────────────

export interface Transport {
	send(method: string, params?: unknown): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	close(): void;
	/** True once the transport can no longer carry a request (the server exited). */
	readonly closed?: boolean;
}

// ── JSON-RPC helpers ─────────────────────────────────────────────

interface JSONRPCRequest {
	jsonrpc: "2.0";
	id?: number;
	method: string;
	params?: unknown;
}

interface JSONRPCResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/**
 * A JSON-RPC error answer, keeping the code and data the peer sent so the
 * client can tell a modern MCP error (-32020..-32022) from anything else.
 * The message is the peer's, unchanged.
 */
export class MCPRPCError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: unknown,
	) {
		super(message);
	}
}

// ── Stdio Transport ──────────────────────────────────────────────

/**
 * The parent environment a stdio server inherits: enough to find and run a
 * program, nothing else. Every other variable (API keys, tokens) stays in
 * this process; a server that needs one names it in its own config env.
 */
const SERVER_ENV_KEYS = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|TMPDIR|LC_[A-Z_]+)$/;

export function serverEnv(
	own: Record<string, string> | undefined,
	parent: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(parent))
		if (v !== undefined && SERVER_ENV_KEYS.test(k)) env[k] = v;
	return { ...env, ...own };
}

/** Longest JSON-RPC line a server may send (UTF-16 units); over it the transport closes. */
export const MAX_MESSAGE_CHARS = 16 * 1024 * 1024;

export class StdioTransport implements Transport {
	private proc: Subprocess | null = null;
	private requestId = 0;
	private pending = new Map<
		number,
		{
			resolve: (v: unknown) => void;
			reject: (e: Error) => void;
		}
	>();
	// The unfinished line, kept as chunks so each byte is scanned once.
	private partial: string[] = [];
	private partialLength = 0;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private closedReason: string | null = null;

	constructor(
		private command: string,
		private args: string[] = [],
		private env?: Record<string, string>,
	) {}

	async start(): Promise<void> {
		this.proc = spawn({
			cmd: [this.command, ...this.args],
			env: serverEnv(this.env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		// On Windows the stdout reader can stay pending after the child has exited, which
		// left every request waiting out its 30 s timeout. Once the process is gone, give
		// the reader a moment to deliver what is already buffered, then shut down.
		const proc = this.proc;
		void proc.exited.then(() => {
			setTimeout(() => {
				if (this.proc === proc) this._shutdown("MCP server exited");
			}, 250);
		});

		// Read stderr in background (logging)
		this._readStderr();

		// Start reading stdout for JSON-RPC responses
		this._readStdout();
	}

	private async _readStdout(): Promise<void> {
		if (!this.proc?.stdout) return;
		const decoder = new TextDecoder();
		this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();

		try {
			while (true) {
				if (!this.reader) return;
				const { done, value } = await this.reader.read();
				if (done) break;
				this._processChunk(decoder.decode(value, { stream: true }));
				if (this.closedReason) return;
			}
		} catch {
			// Process exited
		}
		// The server's output ended: nothing pending can be answered now.
		this._shutdown("MCP server closed its output");
	}

	private async _readStderr(): Promise<void> {
		if (!this.proc?.stderr) return;
		const decoder = new TextDecoder();
		const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				// Swallow stderr - MCP servers log here
			}
		} catch {
			// Done
		}
	}

	/** Split on newlines scanning only the new chunk; a line over the cap closes the transport. */
	private _processChunk(text: string): void {
		let start = 0;
		let nl = text.indexOf("\n");
		while (nl >= 0) {
			if (this.partialLength + nl - start > MAX_MESSAGE_CHARS) {
				this._overCap();
				return;
			}
			const line = this.partial.length
				? this.partial.join("") + text.slice(start, nl)
				: text.slice(start, nl);
			this.partial = [];
			this.partialLength = 0;
			this._handleLine(line);
			start = nl + 1;
			nl = text.indexOf("\n", start);
		}
		if (start < text.length) {
			this.partial.push(text.slice(start));
			this.partialLength += text.length - start;
			if (this.partialLength > MAX_MESSAGE_CHARS) this._overCap();
		}
	}

	private _overCap(): void {
		this.partial = [];
		this.partialLength = 0;
		this._shutdown(
			`MCP server sent a message over ${MAX_MESSAGE_CHARS} characters; transport closed`,
		);
	}

	private _handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		try {
			const msg = JSON.parse(trimmed) as JSONRPCResponse & { method?: unknown };
			// A message with `method` is the server's own request, not an answer:
			// its id is the server's, so it must not settle one of ours.
			if (msg.id !== undefined && msg.method === undefined) {
				const p = this.pending.get(msg.id);
				if (p) {
					this.pending.delete(msg.id);
					if (msg.error) {
						p.reject(new MCPRPCError(msg.error.message, msg.error.code, msg.error.data));
					} else {
						p.resolve(msg.result);
					}
				}
			}
		} catch {
			// Not valid JSON, skip
		}
	}

	async send(method: string, params?: unknown): Promise<unknown> {
		if (this.closedReason) throw new Error(this.closedReason);
		if (!this.proc?.stdin) throw new Error("Transport not started");

		const id = ++this.requestId;
		const req: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request timeout: ${method}`));
			}, 30_000);

			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timeout);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timeout);
					reject(e);
				},
			});

			try {
				this._write(req);
			} catch (err) {
				this.pending.delete(id);
				clearTimeout(timeout);
				reject(err as Error);
			}
		});
	}

	notify(method: string, params?: unknown): void {
		if (!this.proc?.stdin) return;
		try {
			this._write({ jsonrpc: "2.0", method, params });
		} catch {
			// A notification has no answer to fail; a dead server shows up on the next send.
		}
	}

	// Bun's spawn({ stdin: "pipe" }) hands back a FileSink (write + flush), not
	// a WritableStream: the old getWriter() call threw on every request, so no
	// stdio server could ever connect (found under #3474).
	private _write(msg: JSONRPCRequest): void {
		const sink = this.proc?.stdin as unknown as {
			write(chunk: string): unknown;
			flush?(): unknown;
		};
		sink.write(`${JSON.stringify(msg)}\n`);
		// flush() may return a promise that rejects once the server has gone.
		const flushed = sink.flush?.() as Promise<unknown> | undefined;
		if (flushed && typeof flushed.catch === "function") flushed.catch(() => {});
	}

	close(): void {
		this._shutdown("Transport closed");
	}

	get closed(): boolean {
		return this.closedReason !== null;
	}

	/** Kill the server and reject everything still waiting on it. Idempotent. */
	private _shutdown(reason: string): void {
		this.closedReason ??= reason;
		this.reader?.cancel().catch(() => {});
		this.reader = null;
		try {
			this.proc?.kill();
		} catch {}
		this.proc = null;
		for (const [, p] of this.pending) {
			p.reject(new Error(reason));
		}
		this.pending.clear();
	}
}

// ── SSE Transport ────────────────────────────────────────────────

export const MAX_REDIRECTS = 5;

/**
 * fetch() for the configured MCP endpoint. Follow redirects only within the
 * configured origin (scheme, host and port); any other target, or more than
 * MAX_REDIRECTS hops, is an error. 307/308 repeat the request as sent; 303,
 * and 301/302 after a POST, become a bodiless GET, as the fetch spec does.
 */
export async function sameOriginFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const origin = new URL(url).origin;
	let current = url;
	let req: RequestInit = init;
	for (let hop = 0; ; hop++) {
		const res = await fetch(current, { ...req, redirect: "manual" });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
		if (!location) return res;
		const next = new URL(location, current);
		if (next.origin !== origin) {
			throw new Error(
				`MCP endpoint ${origin} redirected to a different origin (${next.origin}); configure the final URL instead`,
			);
		}
		if (hop >= MAX_REDIRECTS) {
			throw new Error(`MCP endpoint ${origin} redirected more than ${MAX_REDIRECTS} times`);
		}
		const method = (req.method ?? "GET").toUpperCase();
		if (
			(res.status === 303 && method !== "HEAD") ||
			((res.status === 301 || res.status === 302) && method === "POST")
		) {
			const headers = new Headers(req.headers);
			for (const h of [
				"content-type",
				"content-length",
				"content-encoding",
				"content-language",
				"content-location",
			]) {
				headers.delete(h);
			}
			req = { ...req, method: "GET", body: undefined, headers };
		}
		await res.body?.cancel();
		current = next.href;
	}
}

export class SSETransport implements Transport {
	private requestId = 0;
	private endpoint: string;
	private headers: Record<string, string>;
	private abortController: AbortController | null = null;

	constructor(url: string, headers?: Record<string, string>) {
		// SSE endpoint for receiving; POST to same base for sending
		this.endpoint = url;
		this.headers = headers || {};
	}

	async send(method: string, params?: unknown): Promise<unknown> {
		const id = ++this.requestId;
		const req: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };

		const modern = modernHeaders(method, params);

		const res = await sameOriginFetch(this.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...this.headers,
				...modern,
			},
			body: JSON.stringify(req),
		});

		if (!res.ok) {
			// A modern server explains a 4xx in a JSON-RPC error body (#3549).
			const err = modern ? await errorBody(res) : null;
			if (err) throw new MCPRPCError(err.message, err.code, err.data);
			throw new Error(`MCP SSE request failed: ${res.status} ${res.statusText}`);
		}

		const body =
			modern && res.headers.get("content-type")?.includes("text/event-stream")
				? sseResponse(await res.text(), id)
				: ((await res.json()) as JSONRPCResponse);
		if (body.error) {
			throw new MCPRPCError(body.error.message, body.error.code, body.error.data);
		}
		return body.result;
	}

	notify(method: string, params?: unknown): void {
		const req: JSONRPCRequest = { jsonrpc: "2.0", method, params };
		sameOriginFetch(this.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.headers },
			body: JSON.stringify(req),
		}).catch(() => {});
	}

	close(): void {
		this.abortController?.abort();
	}
}

// ── Modern (2026-07-28) HTTP request metadata, #3549 ─────────────

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/** RFC 9110 visible ASCII plus inner spaces, and not the Base64 sentinel itself. */
function headerValue(v: string): string {
	const plain = /^[\x21-\x7E]([\x20-\x7E]*[\x21-\x7E])?$/.test(v);
	const sentinel = v.startsWith("=?base64?") && v.endsWith("?=");
	return plain && !sentinel ? v : `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/**
 * The headers a modern request mirrors from its body, or null for a request
 * that carries no modern `_meta` (legacy requests are sent exactly as before).
 */
function modernHeaders(method: string, params: unknown): Record<string, string> | null {
	const p = params as
		| { name?: unknown; uri?: unknown; _meta?: Record<string, unknown> }
		| undefined;
	const version = p?._meta?.[VERSION_KEY];
	if (typeof version !== "string") return null;
	const h: Record<string, string> = {
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": version,
		"Mcp-Method": method,
	};
	const name = typeof p?.name === "string" ? p.name : typeof p?.uri === "string" ? p.uri : null;
	if (name !== null) h["Mcp-Name"] = headerValue(name);
	return h;
}

/** The JSON-RPC error in a failed response's body, if it has one. */
async function errorBody(res: Response): Promise<JSONRPCResponse["error"] | null> {
	try {
		const body = (await res.json()) as JSONRPCResponse;
		return typeof body?.error?.code === "number" ? body.error : null;
	} catch {
		return null;
	}
}

/** The response to request `id` in an SSE reply; notifications before it are skipped. */
function sseResponse(text: string, id: number): JSONRPCResponse {
	for (const event of text.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data) continue;
		try {
			const msg = JSON.parse(data) as JSONRPCResponse & { method?: unknown };
			if (msg.id === id && msg.method === undefined) return msg;
		} catch {
			// Not JSON: not ours.
		}
	}
	throw new Error("MCP SSE stream ended without a response");
}
