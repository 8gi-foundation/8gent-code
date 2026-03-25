/**
 * JSON-RPC 2.0 over Unix domain sockets.
 * Lightweight inter-process communication for agent-to-agent calls.
 *
 * Usage:
 *   const server = new RPCServer('/tmp/eight.sock');
 *   server.register('ping', async () => 'pong');
 *   await server.listen();
 *
 *   const client = new RPCClient('/tmp/eight.sock');
 *   const result = await client.call('ping'); // => 'pong'
 *   client.close();
 */

import net from 'net';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type RpcHandler = (params?: unknown) => Promise<unknown>;

// Standard JSON-RPC error codes
export const RPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: 'Parse error' },
  INVALID_REQUEST:  { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS:   { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR:   { code: -32603, message: 'Internal error' },
  TIMEOUT:          { code: -32000, message: 'Request timed out' },
} as const;

// ---------------------------------------------------------------------------
// RPCServer
// ---------------------------------------------------------------------------

export class RPCServer {
  private server: net.Server;
  private methods = new Map<string, RpcHandler>();

  constructor(private readonly socketPath: string) {
    this.server = net.createServer((socket) => this._handleConnection(socket));
  }

  /** Register a method handler. */
  register(method: string, handler: RpcHandler): this {
    this.methods.set(method, handler);
    return this;
  }

  /** Start listening on the Unix socket. Removes stale socket file first. */
  async listen(): Promise<void> {
    try {
      const fs = await import('fs');
      fs.unlinkSync(this.socketPath);
    } catch { /* no stale socket */ }

    return new Promise((resolve, reject) => {
      this.server.listen(this.socketPath, () => resolve());
      this.server.once('error', reject);
    });
  }

  /** Graceful shutdown. */
  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private _handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this._dispatch(socket, line.trim());
      }
    });
  }

  private async _dispatch(socket: net.Socket, raw: string): Promise<void> {
    let id = '';
    try {
      const req: RpcRequest = JSON.parse(raw);
      id = req.id ?? '';

      if (req.jsonrpc !== '2.0' || !req.method) {
        return this._send(socket, { jsonrpc: '2.0', id, error: RPC_ERRORS.INVALID_REQUEST });
      }

      const handler = this.methods.get(req.method);
      if (!handler) {
        return this._send(socket, { jsonrpc: '2.0', id, error: RPC_ERRORS.METHOD_NOT_FOUND });
      }

      const result = await handler(req.params);
      this._send(socket, { jsonrpc: '2.0', id, result });
    } catch (err) {
      const error = err instanceof SyntaxError
        ? RPC_ERRORS.PARSE_ERROR
        : { ...RPC_ERRORS.INTERNAL_ERROR, data: String(err) };
      this._send(socket, { jsonrpc: '2.0', id, error });
    }
  }

  private _send(socket: net.Socket, response: RpcResponse): void {
    socket.write(JSON.stringify(response) + '\n');
  }
}

// ---------------------------------------------------------------------------
// RPCClient
// ---------------------------------------------------------------------------

export class RPCClient {
  private socket: net.Socket | null = null;
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly socketPath: string,
    private readonly defaultTimeout = 10_000,
  ) {}

  /** Call a remote method. Connects lazily on first call. */
  async call<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T> {
    const socket = await this._connect();
    const id = randomUUID();
    const ms = timeout ?? this.defaultTimeout;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(RPC_ERRORS.TIMEOUT.message));
      }, ms);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
      socket.write(JSON.stringify(req) + '\n');
    });
  }

  /** Close the underlying socket. */
  close(): void {
    this.socket?.destroy();
    this.socket = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error('Client closed'));
    }
    this.pending.clear();
  }

  private _connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);

    return new Promise((resolve, reject) => {
      let buffer = '';
      const socket = net.createConnection(this.socketPath, () => {
        this.socket = socket;
        resolve(socket);
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this._handleResponse(line.trim());
        }
      });

      socket.on('error', (err) => {
        if (!this.socket) reject(err);
      });
      socket.on('close', () => { this.socket = null; });
    });
  }

  private _handleResponse(raw: string): void {
    let res: RpcResponse;
    try { res = JSON.parse(raw); } catch { return; }

    const pending = this.pending.get(res.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(res.id);

    if (res.error) {
      pending.reject(Object.assign(new Error(res.error.message), { code: res.error.code }));
    } else {
      pending.resolve(res.result);
    }
  }
}
