/**
 * MCP Transport Abstraction
 *
 * Two transports:
 * - StdioTransport: spawn a process, JSON-RPC over stdin/stdout
 * - SSETransport: fetch-based SSE connection to an HTTP MCP endpoint
 */

import { spawn, type Subprocess } from "bun";

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

export class StdioTransport implements Transport {
  private proc: Subprocess | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private buffer = "";
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  constructor(
    private command: string,
    private args: string[] = [],
    private env?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    this.proc = spawn({
      cmd: [this.command, ...this.args],
      env: { ...process.env, ...this.env },
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
    this.reader = this.proc.stdout.getReader();

    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this._processBuffer();
      }
    } catch {
      // Process exited
    }
  }

  private async _readStderr(): Promise<void> {
    if (!this.proc?.stderr) return;
    const decoder = new TextDecoder();
    const reader = this.proc.stderr.getReader();
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

  private _processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JSONRPCResponse;
        if (msg.id !== undefined) {
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
  }

  async send(method: string, params?: unknown): Promise<unknown> {
    if (!this.proc?.stdin) throw new Error("Transport not started");

    const id = ++this.requestId;
    const req: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      const writer = this.proc!.stdin as WritableStream;
      const w = writer.getWriter();
      w.write(new TextEncoder().encode(JSON.stringify(req) + "\n"));
      w.releaseLock();
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc?.stdin) return;
    const req: JSONRPCRequest = { jsonrpc: "2.0", method, params };
    const writer = (this.proc.stdin as WritableStream).getWriter();
    writer.write(new TextEncoder().encode(JSON.stringify(req) + "\n"));
    writer.releaseLock();
  }

  close(): void {
    this.reader?.cancel().catch(() => {});
    this.proc?.kill();
    this.proc = null;
    for (const [, p] of this.pending) {
      p.reject(new Error("Transport closed"));
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

    const body = await res.json() as JSONRPCResponse;
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
