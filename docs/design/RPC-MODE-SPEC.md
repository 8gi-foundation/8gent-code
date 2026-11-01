# RPC Mode Spec

> Issue #947 - JSON-RPC mode for headless/CI/IDE integration

## Problem

Eight only runs as an interactive TUI. IDEs, CI pipelines, and other tools cannot programmatically send tasks and receive structured results. We need a headless JSON-RPC mode over stdin/stdout.

## Constraint

Must use standard JSON-RPC 2.0 over stdin/stdout - no HTTP server, no WebSocket (those exist in the daemon already). This is for single-process embedding where the caller spawns `8gent --rpc` as a child process.

## Not doing

- HTTP/WebSocket RPC (already handled by `packages/daemon/`)
- Authentication (single-process, trusted caller)
- Multi-session multiplexing over one RPC connection
- GUI/TUI rendering in RPC mode

## Success metric

A CI script can spawn `8gent --rpc`, send a task, receive streaming tool call events and the final response, then exit - all via structured JSON over stdio.

---

## 1. Protocol

JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout. One JSON object per line.

```typescript
// Request (caller -> 8gent)
interface RPCRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

// Response (8gent -> caller)
interface RPCResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Notification (8gent -> caller, no id)
interface RPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
```

---

## 2. Methods

### Requests (caller sends, expects response)

| Method | Params | Result | Description |
|--------|--------|--------|-------------|
| `session.create` | `{ model?, cwd? }` | `{ sessionId }` | Start a new session |
| `session.message` | `{ sessionId, content }` | `{ response, usage }` | Send a message, get final response |
| `session.abort` | `{ sessionId }` | `{ ok: true }` | Abort current generation |
| `session.destroy` | `{ sessionId }` | `{ ok: true }` | End session, clean up |
| `tools.list` | `{}` | `{ tools: ToolDef[] }` | List available tools |

### Notifications (8gent emits during processing)

| Method | Params | Description |
|--------|--------|-------------|
| `stream.token` | `{ sessionId, token }` | Streaming token |
| `stream.toolCall` | `{ sessionId, tool, args }` | Tool invocation started |
| `stream.toolResult` | `{ sessionId, tool, result }` | Tool completed |
| `stream.done` | `{ sessionId }` | Generation complete |
| `stream.error` | `{ sessionId, error }` | Error during processing |

---

## 3. Session Lifecycle

```
Caller                          8gent --rpc
  |-- session.create ------------>|
  |<-- { sessionId } -------------|
  |-- session.message ----------->|
  |<-- stream.token --------------|  (repeated)
  |<-- stream.toolCall -----------|
  |<-- stream.toolResult ---------|
  |<-- stream.done ---------------|
  |<-- response ------------------|
  |-- session.destroy ----------->|
  |<-- { ok } -------------------|
```

---

## 4. CI/CD Example

```bash
#!/bin/bash
# Run 8gent in RPC mode for a CI task
echo '{"jsonrpc":"2.0","id":1,"method":"session.create","params":{"cwd":"."}}' | 8gent --rpc
# Read responses line by line, parse JSON, act on results
```

```typescript
// Node.js integration
import { spawn } from "child_process";
const agent = spawn("8gent", ["--rpc"]);
agent.stdin.write(JSON.stringify({
  jsonrpc: "2.0", id: 1,
  method: "session.create",
  params: { cwd: process.cwd() }
}) + "\n");
```

---

## 5. Stderr for Logs

All human-readable logs go to stderr. Stdout is reserved exclusively for JSON-RPC messages. This allows `2>/dev/null` to suppress logs while keeping structured output clean.

---

## 6. Files to Create/Modify

**Create:**
- `packages/eight/rpc-server.ts` - stdin/stdout JSON-RPC handler, method dispatch (~200 lines)
- `packages/eight/rpc-types.ts` - request/response/notification types (~50 lines)

**Modify:**
- `bin/8gent.ts` - add `--rpc` flag, bypass TUI, launch RPC server (~25 lines)
- `packages/eight/agent.ts` - expose event emitter for tool call/result streaming (~15 lines)

## 7. Estimated Effort

2 new files (~250 lines), 2 modified files (~40 lines). Total: ~290 lines across 4 files.

Architecture reference: Claude Code's own `--print` mode and MCP's stdio transport. Also inspired by LSP's JSON-RPC protocol (which we already use in `packages/lsp/`).
