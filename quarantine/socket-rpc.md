# socket-rpc

## Tool Name
`socket-rpc`

## Description
Lightweight JSON-RPC 2.0 server and client over Unix domain sockets. Enables low-latency,
typed inter-process communication between Eight kernel instances, sub-agents, worktree
workers, and any local process that needs to call into the daemon without HTTP overhead.

Features:
- JSON-RPC 2.0 request/response framing (newline-delimited over the socket)
- `RPCServer` - register named method handlers, listen on a Unix socket path
- `RPCClient` - lazy connect, call remote methods with per-request timeout
- Full request/response correlation via UUID `id` field
- Standard error codes (parse error, method not found, internal error, timeout)
- Graceful shutdown on both client and server

## Status
**quarantine** - implementation complete, not yet wired into any production path.

## Integration Path
1. **daemon/index.ts** - instantiate `RPCServer` on `.8gent/eight.sock` alongside the
   existing WebSocket gateway. Register core methods: `agent.run`, `agent.abort`,
   `pool.status`, `memory.query`.
2. **packages/orchestration/worktree-pool.ts** - use `RPCClient` for sub-agent
   delegation instead of in-process function calls, enabling true process isolation.
3. **apps/tui** - optionally connect via `RPCClient` for zero-HTTP status polling
   during sessions.
4. **CI gate** - add a smoke test: spin up `RPCServer`, call `ping`, assert `pong`,
   assert timeout fires correctly, assert method-not-found error code.

## File
`packages/daemon/socket-rpc.ts` (~160 lines, zero external dependencies)
