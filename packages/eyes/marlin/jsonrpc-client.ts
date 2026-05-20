/**
 * @8gent/eyes — Marlin sidecar JSON-RPC 2.0 client.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over a child process's stdin/stdout
 * (VIDEO-INGESTION spec §4.2, §5). stderr is reserved for human-readable
 * logs and is never parsed — it is buffered as a tail for crash diagnostics.
 *
 * The real sidecar is `python -m marlin_sidecar` inside the provisioned venv
 * (#2631). That sidecar is built in parallel and is NOT on main. This client
 * is written against the spec's protocol and is tested against a FAKE
 * sidecar fixture (see __tests__/fake-sidecar.ts). The spawn command is
 * therefore injectable via `SidecarSpawnSpec`.
 *
 * Lifecycle (spec §4.3):
 *   spawn → wait for `ready` notification → `initialize` → serve → shutdown.
 */

import { type ChildProcess, spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

interface RpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

interface RpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: RpcError;
}

interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** A JSON-RPC error surfaced as a thrown Error with the structured payload. */
export class SidecarRpcError extends Error {
	readonly code: number;
	readonly data: unknown;
	constructor(err: RpcError) {
		super(`marlin sidecar error ${err.code}: ${err.message}`);
		this.name = "SidecarRpcError";
		this.code = err.code;
		this.data = err.data;
	}
}

/** Raised when the sidecar process dies, fails to start, or times out. */
export class SidecarProcessError extends Error {
	readonly stderrTail: string;
	constructor(message: string, stderrTail: string) {
		super(message);
		this.name = "SidecarProcessError";
		this.stderrTail = stderrTail;
	}
}

/** How to spawn the sidecar. Injectable so tests can use a fake process. */
export interface SidecarSpawnSpec {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface SidecarClientOpts {
	/** Milliseconds to wait for the `ready` notification. Default 30000. */
	readyTimeoutMs?: number;
	/** Milliseconds to wait for a single RPC reply. Default 600000. */
	requestTimeoutMs?: number;
}

const STDERR_TAIL_BYTES = 4096;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * A connected, ready Marlin sidecar. Construct via `MarlinSidecarClient.start`.
 * One inference at a time — the sidecar queues internally (spec §4.1); this
 * client does not assume parallelism but does not serialize either, the
 * caller drives one request at a time.
 */
export class MarlinSidecarClient {
	private readonly proc: ChildProcess;
	private readonly readyTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private nextId = 1;
	private stdoutBuf = "";
	private stderrTail = "";
	private exited = false;
	private readonly pending = new Map<
		number,
		{
			resolve: (v: unknown) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private readyResolve: (() => void) | null = null;
	private readyReject: ((e: Error) => void) | null = null;
	private readyDone = false;

	private constructor(proc: ChildProcess, opts: SidecarClientOpts) {
		this.proc = proc;
		this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
		this.requestTimeoutMs = opts.requestTimeoutMs ?? 600_000;

		proc.stdout?.setEncoding("utf-8");
		proc.stderr?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		proc.stderr?.on("data", (chunk: string) => this.onStderr(chunk));
		proc.on("exit", (code, signal) => this.onExit(code, signal));
		proc.on("error", (err) => this.onSpawnError(err));
	}

	/** The sidecar process id, or undefined if it never spawned. */
	get pid(): number | undefined {
		return this.proc.pid;
	}

	/** Whether the process has exited. */
	get hasExited(): boolean {
		return this.exited;
	}

	/** The most recent stderr output, capped for diagnostics. */
	get stderr(): string {
		return this.stderrTail;
	}

	/**
	 * Spawn the sidecar and wait for its `ready` notification (spec §4.3 step
	 * 2). Does NOT call `initialize` — that is a separate, slow call the
	 * caller makes explicitly.
	 */
	static async start(
		spec: SidecarSpawnSpec,
		opts: SidecarClientOpts = {},
	): Promise<MarlinSidecarClient> {
		const proc = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: { ...process.env, ...spec.env, PYTORCH_ENABLE_MPS_FALLBACK: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = new MarlinSidecarClient(proc, opts);
		await client.waitForReady();
		return client;
	}

	private waitForReady(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.readyDone) {
				resolve();
				return;
			}
			this.readyResolve = resolve;
			this.readyReject = reject;
			const timer = setTimeout(() => {
				if (this.readyDone) return;
				this.readyDone = true;
				this.readyReject?.(
					new SidecarProcessError(
						`marlin sidecar did not emit 'ready' within ${this.readyTimeoutMs}ms`,
						this.stderrTail,
					),
				);
			}, this.readyTimeoutMs);
			// Chain timer cleanup onto the resolve/reject paths.
			const origResolve = this.readyResolve;
			const origReject = this.readyReject;
			this.readyResolve = () => {
				clearTimeout(timer);
				origResolve?.();
			};
			this.readyReject = (e: Error) => {
				clearTimeout(timer);
				origReject?.(e);
			};
		});
	}

	// --- I/O handling -------------------------------------------------------

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		// Drain every complete newline-delimited frame.
		for (let nl = this.stdoutBuf.indexOf("\n"); nl !== -1; nl = this.stdoutBuf.indexOf("\n")) {
			const line = this.stdoutBuf.slice(0, nl).trim();
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (line.length === 0) continue;
			this.dispatchLine(line);
		}
	}

	private onStderr(chunk: string): void {
		this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
	}

	private dispatchLine(line: string): void {
		let msg: RpcResponse | RpcNotification;
		try {
			msg = JSON.parse(line) as RpcResponse | RpcNotification;
		} catch {
			// A non-JSON line on stdout violates the protocol. Treat it as a
			// diagnostic, not a fatal error — keep serving.
			this.stderrTail = `${this.stderrTail}\n[non-json stdout] ${line}`.slice(-STDERR_TAIL_BYTES);
			return;
		}
		// Notification (no id) — `ready` is the one we act on.
		if (!("id" in msg) || msg.id === undefined || msg.id === null) {
			const note = msg as RpcNotification;
			if (note.method === "ready" && !this.readyDone) {
				this.readyDone = true;
				this.readyResolve?.();
			}
			return;
		}
		const resp = msg as RpcResponse;
		const entry = this.pending.get(resp.id);
		if (!entry) return; // stale or unknown id
		this.pending.delete(resp.id);
		clearTimeout(entry.timer);
		if (resp.error) {
			entry.reject(new SidecarRpcError(resp.error));
		} else {
			entry.resolve(resp.result);
		}
	}

	private onExit(code: number | null, signal: string | null): void {
		this.exited = true;
		const err = new SidecarProcessError(
			`marlin sidecar exited (code=${code}, signal=${signal})`,
			this.stderrTail,
		);
		if (!this.readyDone) {
			this.readyDone = true;
			this.readyReject?.(err);
		}
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(err);
		}
		this.pending.clear();
	}

	private onSpawnError(err: Error): void {
		this.exited = true;
		const wrapped = new SidecarProcessError(
			`marlin sidecar failed to spawn: ${err.message}`,
			this.stderrTail,
		);
		if (!this.readyDone) {
			this.readyDone = true;
			this.readyReject?.(wrapped);
		}
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(wrapped);
		}
		this.pending.clear();
	}

	// --- RPC ----------------------------------------------------------------

	/**
	 * Send a JSON-RPC request and await the typed result. Rejects with a
	 * `SidecarRpcError` on a JSON-RPC error, or a `SidecarProcessError` if
	 * the process dies or the call times out.
	 */
	request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		if (this.exited) {
			return Promise.reject(
				new SidecarProcessError(
					`cannot call ${method}: marlin sidecar has exited`,
					this.stderrTail,
				),
			);
		}
		const id = this.nextId++;
		const req: RpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new SidecarProcessError(
						`marlin sidecar call ${method} timed out after ${this.requestTimeoutMs}ms`,
						this.stderrTail,
					),
				);
			}, this.requestTimeoutMs);
			this.pending.set(id, {
				resolve: resolve as (v: unknown) => void,
				reject,
				timer,
			});
			const ok = this.proc.stdin?.write(`${JSON.stringify(req)}\n`);
			if (ok === false) {
				// Backpressure is fine; failure to write at all is not.
				this.proc.stdin?.once("error", (e: Error) => {
					const entry = this.pending.get(id);
					if (!entry) return;
					this.pending.delete(id);
					clearTimeout(entry.timer);
					reject(new SidecarProcessError(`stdin write failed: ${e.message}`, this.stderrTail));
				});
			}
		});
	}

	/** Graceful stop: send `shutdown`, then kill if it lingers. */
	async stop(): Promise<void> {
		if (this.exited) return;
		try {
			await this.request("shutdown");
		} catch {
			// Sidecar may close the pipe before replying — acceptable.
		}
		if (!this.exited) {
			this.proc.kill("SIGTERM");
		}
	}

	/** Force-kill without a graceful shutdown. */
	kill(): void {
		if (!this.exited) this.proc.kill("SIGKILL");
	}
}
