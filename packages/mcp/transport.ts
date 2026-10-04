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
						p.reject(new Error(msg.error.message));
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

		const res = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...this.headers,
			},
			body: JSON.stringify(req),
		});

		if (!res.ok) {
			throw new Error(`MCP SSE request failed: ${res.status} ${res.statusText}`);
		}

		const body = (await res.json()) as JSONRPCResponse;
		if (body.error) {
			throw new Error(body.error.message);
		}
		return body.result;
	}

	notify(method: string, params?: unknown): void {
		const req: JSONRPCRequest = { jsonrpc: "2.0", method, params };
		fetch(this.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...this.headers },
			body: JSON.stringify(req),
		}).catch(() => {});
	}

	close(): void {
		this.abortController?.abort();
	}
}
