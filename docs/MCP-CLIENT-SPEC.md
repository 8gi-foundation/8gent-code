# MCP Client Spec - 8gent Code

**Status:** Proposed
**Issue:** #935
**Package:** `packages/mcp/` (existing, needs upgrade)
**Protocol version:** 2024-11-05

## Problem

8gent has a basic MCP client (`packages/mcp/index.ts`) that supports stdio transport only, has no security gating, no SSE support, no health checks, and no reconnect logic. It works but is fragile and incomplete.

## Goal

A production-grade MCP client that discovers external tools from any MCP server, registers them as first-class 8gent tools, and gates every call through NemoClaw policy engine. Users configure servers in `~/.8gent/mcp.json` - zero code required.

## Non-goals

- Building an MCP server (8gent is a client only)
- Using `@modelcontextprotocol/sdk` as a dependency (we keep deps minimal - rebuild the client protocol in <500 lines)
- Resource or prompt MCP capabilities (tools only, for now)

---

## 1. Config Format

**Path:** `~/.8gent/mcp.json`

Mirrors the Claude Code format for familiarity. Users who already have `~/.claude/mcp.json` can copy it over.

### Schema

```typescript
interface MCPConfigFile {
  mcpServers: Record<string, MCPServerEntry>;
}

interface MCPServerEntry {
  // --- stdio transport (default) ---
  command?: string;          // e.g. "bunx", "npx", "uvx", "node"
  args?: string[];           // e.g. ["contextplus"]
  env?: Record<string, string>;

  // --- SSE transport ---
  type?: "stdio" | "sse";   // default: "stdio" (inferred if command present)
  url?: string;              // required when type="sse", e.g. "http://127.0.0.1:14523/sse"

  // --- common ---
  enabled?: boolean;         // default: true. Set false to skip without removing.
  timeout?: number;          // per-request timeout in ms. Default: 30000.
  policy?: "allow" | "ask" | "block";  // override NemoClaw decision for all tools from this server
}
```

### Sample mcp.json

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"],
      "env": {}
    },
    "browser-tools": {
      "type": "sse",
      "url": "http://127.0.0.1:14523/sse"
    },
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"],
      "enabled": false
    }
  }
}
```

### Validation rules

- If `command` is present and `type` is absent, infer `type: "stdio"`.
- If `type: "sse"`, `url` is required. Reject config without it.
- If `type: "stdio"`, `command` is required. Reject config without it.
- Unknown keys are silently ignored (forward compat).

---

## 2. Transport Support

### 2.1 stdio

Current implementation. Spawn a child process, communicate via JSON-RPC 2.0 over stdin/stdout.

**Message framing:** newline-delimited JSON. Each message is one line terminated by `\n`. The existing `processBuffer` approach (split on newline, keep partial tail) is correct.

**Changes needed:**
- Add Content-Length header framing as fallback (some servers use HTTP-style headers before JSON body)
- Stderr goes to 8gent debug log, not console.error

### 2.2 SSE (Server-Sent Events)

For servers already running as HTTP endpoints (e.g. Chrome MCP bridge at `http://127.0.0.1:14523/sse`).

**Protocol flow:**
1. Client opens GET request to `{url}` with `Accept: text/event-stream`
2. Server sends `endpoint` event with a POST URL for sending requests
3. Client sends JSON-RPC requests via POST to that endpoint
4. Server streams JSON-RPC responses back over the SSE connection

**Implementation:** Use native `fetch` (Bun supports streaming responses) + `eventsource-parser` for SSE parsing. No heavy deps.

---

## 3. Tool Discovery

When an MCP server starts and completes the handshake, 8gent calls `tools/list` and registers each tool.

### Naming convention

MCP tools are namespaced: `mcp__{serverName}__{toolName}`

Example: server `filesystem` with tool `read_file` becomes `mcp__filesystem__read_file`.

This matches how Claude Code names MCP tools and avoids collisions with built-in 8gent tools.

### Registration flow

```
1. MCPClient.startServer("filesystem")
2. JSON-RPC: initialize -> initialized
3. JSON-RPC: tools/list -> [{ name: "read_file", inputSchema: {...} }, ...]
4. For each tool:
   a. Create Vercel AI SDK tool definition:
      - name: "mcp__filesystem__read_file"
      - description: from MCP tool description
      - parameters: from MCP tool inputSchema (JSON Schema -> Zod via json-schema-to-zod)
   b. Register in ToolExecutor's tool map
5. Tools available to agent on next turn
```

### Dynamic refresh

- `tools/list_changed` notification from server triggers re-registration
- Manual refresh via `mcp_refresh_tools` agent tool

### Agent-facing tools (built-in)

| Tool | Purpose |
|------|---------|
| `mcp_list_tools` | List all MCP tools across all servers (exists, keep) |
| `mcp_call_tool` | Call any MCP tool by server + name (exists, keep) |
| `mcp_refresh_tools` | Re-fetch tool lists from all servers (new) |

The namespaced tools (e.g. `mcp__filesystem__read_file`) are registered directly in the Vercel AI SDK tool array, so the LLM can call them natively without going through `mcp_call_tool`.

---

## 4. Security Integration

Every MCP tool call passes through NemoClaw before execution.

### New policy action type

Add `"mcp_call"` to `PolicyActionType` in `packages/permissions/types.ts`:

```typescript
export type PolicyActionType =
  | "write_file"
  | "read_file"
  | "delete_file"
  | "run_command"
  | "git_push"
  | "git_commit"
  | "network_request"
  | "env_access"
  | "secret_write"
  | "mcp_call";       // NEW
```

### Policy context for MCP calls

```typescript
interface MCPPolicyContext extends PolicyContext {
  server: string;     // "filesystem"
  tool: string;       // "read_file"
  args: string;       // JSON.stringify of arguments (for condition matching)
}
```

### Default policies (add to default-policies.yaml)

```yaml
- name: mcp-require-approval
  action: mcp_call
  condition: "server contains *"
  decision: require_approval
  message: "MCP tool call requires approval"
  enabled: true

- name: mcp-block-destructive
  action: mcp_call
  condition: "tool contains delete or tool contains remove or tool contains drop"
  decision: block
  message: "Destructive MCP tool calls are blocked by default"
  enabled: true
```

### Per-server policy override

The `policy` field in mcp.json lets users skip approval for trusted servers:

- `"allow"` - all tools from this server bypass NemoClaw (user trusts it)
- `"ask"` - default, route through NemoClaw (require_approval)
- `"block"` - all tools from this server are blocked

### Execution flow

```
Agent calls mcp__filesystem__read_file({ path: "/etc/passwd" })
  -> MCPClient.callToolGated("filesystem", "read_file", { path: "/etc/passwd" })
    -> Check server-level policy override
    -> If "ask": evaluatePolicy("mcp_call", { server, tool, args })
    -> If allowed: send JSON-RPC tools/call
    -> If blocked: return error to agent
    -> If requiresApproval: prompt user in TUI
```

---

## 5. Lifecycle

### 5.1 Startup

```
Agent session starts
  -> MCPClient.loadConfig()
  -> For each enabled server (in parallel):
     -> startServer(config)
     -> initialize handshake (5s timeout)
     -> tools/list
     -> register tools
  -> Agent receives merged tool list (built-in + MCP)
```

Servers that fail to start are logged and skipped. Agent still works with remaining tools.

### 5.2 Health check

Every 60 seconds (configurable), send a `ping` JSON-RPC request to each stdio server. For SSE, check the EventSource connection state.

If a server fails 3 consecutive health checks, mark it `degraded` and stop routing tool calls to it. Log a warning.

### 5.3 Reconnect

On unexpected process exit (stdio) or connection drop (SSE):

1. Wait 1s, then retry
2. Exponential backoff: 1s, 2s, 4s, 8s, max 30s
3. Max 5 retries per server per session
4. After max retries, mark server as `dead` and unregister its tools

### 5.4 Shutdown

On agent session end or SIGTERM:

1. Send `notifications/cancelled` to each server (best effort)
2. Kill child processes (stdio) with SIGTERM, then SIGKILL after 3s
3. Close SSE connections
4. Clear tool registrations

---

## 6. Package Structure

Upgrade `packages/mcp/` from single file to proper module:

```
packages/mcp/
  index.ts              # Public API: MCPClient, getMCPClient, types
  client.ts             # Core MCPClient class (refactored from current index.ts)
  config.ts             # Config loading, validation, schema
  transport-stdio.ts    # Stdio transport (extract from current client)
  transport-sse.ts      # SSE transport (new)
  transport.ts          # Transport interface + factory
  tool-registry.ts      # MCP tool -> 8gent tool registration bridge
  health.ts             # Health check + reconnect logic
  types.ts              # All TypeScript types
  package.json          # Package metadata
```

### Key interfaces

```typescript
// transport.ts
interface MCPTransport {
  connect(): Promise<void>;
  send(request: JSONRPCRequest): Promise<JSONRPCResponse>;
  onNotification(handler: (method: string, params: unknown) => void): void;
  close(): void;
  readonly connected: boolean;
}

// types.ts
type ServerStatus = "starting" | "ready" | "degraded" | "dead" | "stopped";

interface MCPServerState {
  name: string;
  config: MCPServerEntry;
  transport: MCPTransport | null;
  tools: MCPTool[];
  status: ServerStatus;
  lastHealthCheck: number;
  failedHealthChecks: number;
  reconnectAttempts: number;
}

// tool-registry.ts
interface MCPToolRegistration {
  serverId: string;
  mcpName: string;           // original MCP tool name
  eightName: string;         // namespaced: mcp__server__tool
  description: string;
  inputSchema: JSONSchema;   // raw JSON Schema from MCP
}
```

---

## 7. Implementation Plan

### Phase 1 - Refactor (NOW, 1-2 hours)

Split `packages/mcp/index.ts` into the module structure above. No new features, just extract into files. All existing tests/imports keep working.

**Files touched:** `packages/mcp/index.ts` (split), `packages/mcp/package.json` (create)

### Phase 2 - SSE Transport (NOW, 2-3 hours)

Implement `transport-sse.ts`. Test against a real SSE MCP server (Chrome bridge or similar).

**Files touched:** `packages/mcp/transport-sse.ts` (new), `packages/mcp/transport.ts` (new), `packages/mcp/config.ts` (add SSE validation)

### Phase 3 - NemoClaw Integration (NEXT, 1-2 hours)

Add `mcp_call` policy action. Wire `callToolGated` method. Add default policies.

**Files touched:** `packages/permissions/types.ts`, `packages/permissions/default-policies.yaml`, `packages/mcp/client.ts`

### Phase 4 - Tool Registration Bridge (NEXT, 2-3 hours)

Auto-register MCP tools as native Vercel AI SDK tools so the LLM calls them directly (not through `mcp_call_tool`).

**Files touched:** `packages/mcp/tool-registry.ts` (new), `packages/eight/tools.ts` (import bridge)

### Phase 5 - Health + Reconnect (LATER, 1-2 hours)

Health check loop, exponential backoff reconnect, status reporting.

**Files touched:** `packages/mcp/health.ts` (new), `packages/mcp/client.ts`

### Total estimated effort: 7-12 hours across phases

---

## 8. Testing Strategy

- **Unit:** Transport message framing, config validation, tool name generation
- **Integration:** Start a real MCP server (use `@modelcontextprotocol/server-filesystem` as test fixture), verify tool discovery and call round-trip
- **Policy:** Verify NemoClaw blocks/allows MCP calls correctly with test policies
- **Reconnect:** Kill a server process mid-session, verify reconnect and tool re-registration

---

## 9. Migration from Current Code

The existing `packages/mcp/index.ts` (~465 lines) is a good starting point. The refactor preserves:

- `MCPClient` class (becomes `client.ts`)
- `getMCPClient()` / `resetMCPClient()` singletons (stay in `index.ts`)
- `formatToolResult()` helper (moves to `types.ts` or stays in `index.ts`)
- All existing type exports

The `mcp_list_tools` and `mcp_call_tool` handlers in `packages/eight/tools.ts` keep working unchanged. Phase 4 adds the auto-registered tools alongside them.
