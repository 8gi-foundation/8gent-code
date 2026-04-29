/**
 * @8gent/terminal-tab — pty-session.ts
 *
 * High-level PTY wrapper used by the TUI. Internally spawns a
 * `pty-bridge.cjs` subprocess under Node, because node-pty's native
 * FD watcher does not work under Bun (where the TUI runs). The bridge
 * holds the real PTY and proxies it as newline-delimited JSON.
 *
 * Interface is intentionally compatible with a direct node-pty wrapper
 * so a future runtime that supports PTY natively can drop the bridge.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findNodeBinary } from "./find-node.js";

export interface PtySessionOpts {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	cols?: number;
	rows?: number;
}

export type DataHandler = (chunk: string) => void;
export type ExitHandler = (code: number | null, signal: number | null) => void;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BRIDGE_PATH = join(__dirname, "pty-bridge.cjs");

interface BridgeProcess {
	pid: number | undefined;
	stdin: { write(data: string): void; end(): void } | null;
	exited: Promise<number>;
	kill(signal?: string): boolean;
}

/**
 * Spawn helper that returns a runtime-agnostic process handle. Using
 * `Bun.spawn` directly gives us streamable readable stdout/stderr and
 * a writable stdin — exactly what we need.
 */
function spawnBridge(
	nodeBin: string,
	command: string,
	args: string[],
	env: Record<string, string>,
) {
	const bunSpawn = (
		globalThis as unknown as {
			Bun?: { spawn: (opts: Record<string, unknown>) => unknown };
		}
	).Bun?.spawn;

	const cmd = [nodeBin, BRIDGE_PATH, command, ...args];

	if (bunSpawn) {
		const p = bunSpawn({
			cmd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		}) as {
			pid: number;
			stdin: { write(s: string): number; end(): void };
			stdout: ReadableStream<Uint8Array>;
			stderr: ReadableStream<Uint8Array>;
			exited: Promise<number>;
			kill(signal?: string): boolean;
		};
		return {
			pid: p.pid,
			stdin: { write: (s: string) => p.stdin.write(s), end: () => p.stdin.end() },
			stdout: p.stdout,
			stderr: p.stderr,
			exited: p.exited,
			kill: (sig?: string) => p.kill(sig),
		};
	}

	// Node fallback (used by unit tests run under Node directly)
	// We use a dynamic require to avoid pulling node:child_process types into the
	// Bun-targeted build paths.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const cp = require("node:child_process") as typeof import("node:child_process");
	const proc = cp.spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], env });
	const stdoutStream = nodeReadableToWebStream(proc.stdout);
	const stderrStream = nodeReadableToWebStream(proc.stderr);
	const exited = new Promise<number>((resolve) => {
		proc.on("exit", (code) => resolve(code ?? 0));
	});
	return {
		pid: proc.pid as number,
		stdin: {
			write: (s: string) => {
				if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(s);
			},
			end: () => {
				if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
			},
		},
		stdout: stdoutStream,
		stderr: stderrStream,
		exited,
		kill: (sig?: NodeJS.Signals | number) => proc.kill(sig as NodeJS.Signals | undefined),
	};
}

function nodeReadableToWebStream(r: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			r.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
			r.on("end", () => controller.close());
			r.on("error", (e) => controller.error(e));
		},
	});
}

interface BridgeMessage {
	type: "ready" | "data" | "exit";
	pid?: number;
	data?: string;
	code?: number;
	signal?: number | null;
}

export class PtySession {
	readonly exited: Promise<number | null>;

	private proc: ReturnType<typeof spawnBridge> | null = null;
	private dataHandlers = new Set<DataHandler>();
	private exitHandlers = new Set<ExitHandler>();
	private _pid: number | null = null;
	private _exitCode: number | null = null;
	private _exitSignal: number | null = null;
	private _alive = false;
	private readyResolver?: () => void;
	readonly ready: Promise<void>;

	constructor(opts: PtySessionOpts) {
		const nodeBin = findNodeBinary() ?? "node";
		const env: Record<string, string> = {
			...((opts.env ?? (process.env as Record<string, string>)) as Record<string, string>),
			PTY_CWD: opts.cwd ?? process.cwd(),
			PTY_COLS: String(opts.cols ?? 120),
			PTY_ROWS: String(opts.rows ?? 30),
		};

		this.ready = new Promise<void>((resolve) => {
			this.readyResolver = resolve;
		});

		this.proc = spawnBridge(nodeBin, opts.command, opts.args ?? [], env);
		this._alive = true;

		// Read stdout: line-delimited JSON
		this.consumeStdout(this.proc.stdout);

		// Drain stderr quietly to avoid back-pressure on the bridge
		void this.proc.stderr
			.getReader()
			.read()
			.catch(() => {});

		this.exited = this.proc.exited.then(() => {
			this._alive = false;
			this._pid = null;
			return this._exitCode;
		});
	}

	get pid(): number | null {
		return this._pid;
	}

	get isAlive(): boolean {
		return this._alive;
	}

	get lastExitCode(): number | null {
		return this._exitCode;
	}

	get lastExitSignal(): number | null {
		return this._exitSignal;
	}

	onData(fn: DataHandler): () => void {
		this.dataHandlers.add(fn);
		return () => this.dataHandlers.delete(fn);
	}

	onExit(fn: ExitHandler): () => void {
		this.exitHandlers.add(fn);
		return () => this.exitHandlers.delete(fn);
	}

	write(input: string): void {
		this.send({ type: "write", data: input });
	}

	resize(cols: number, rows: number): void {
		this.send({ type: "resize", cols: Math.max(1, cols), rows: Math.max(1, rows) });
	}

	kill(signal?: string): void {
		if (!this._alive) return;
		this.send({ type: "kill", signal });
		// Also schedule a hard-kill in case the bridge ignores the message
		setTimeout(() => {
			if (this._alive && this.proc) {
				try {
					this.proc.kill(signal as NodeJS.Signals | undefined);
				} catch {
					/* already dead */
				}
			}
		}, 250);
	}

	private send(msg: Record<string, unknown>): void {
		if (!this.proc?.stdin) return;
		try {
			this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
		} catch {
			/* bridge dead */
		}
	}

	private async consumeStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				buffer += decoder.decode(value, { stream: true });
				let idx;
				while ((idx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					if (!line) continue;
					this.dispatch(line);
				}
			}
		} catch {
			/* bridge stream ended */
		}
	}

	private dispatch(line: string): void {
		let msg: BridgeMessage;
		try {
			msg = JSON.parse(line) as BridgeMessage;
		} catch {
			return;
		}
		switch (msg.type) {
			case "ready":
				this._pid = msg.pid ?? null;
				this.readyResolver?.();
				break;
			case "data":
				if (typeof msg.data === "string") {
					for (const fn of this.dataHandlers) {
						try {
							fn(msg.data);
						} catch {
							/* swallow listener errors */
						}
					}
				}
				break;
			case "exit":
				this._exitCode = msg.code ?? null;
				this._exitSignal = msg.signal ?? null;
				this._alive = false;
				for (const fn of this.exitHandlers) {
					try {
						fn(this._exitCode, this._exitSignal);
					} catch {
						/* swallow */
					}
				}
				break;
		}
	}
}
