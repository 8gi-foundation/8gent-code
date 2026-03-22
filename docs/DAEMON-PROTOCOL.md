# Daemon Protocol v1.0

WebSocket protocol for external clients connecting to the Eight daemon.

This is the contract between the brain (8gent Code daemon) and the interfaces (8gent.app, 8gent OS, Telegram, etc.).

---

## Connection

**Endpoint:** `ws://localhost:18789`
**Health check:** `GET http://localhost:18789/health`

The daemon uses Bun's native WebSocket server. Messages are JSON-encoded strings.

## Authentication

Authentication is optional. When `daemon.authToken` is set in `~/.8gent/config.json`, clients must authenticate before sending any other message.

### Handshake

```
Client -> { "type": "auth", "token": "<auth-token>" }
Server -> { "type": "auth:ok" }
       or { "type": "auth:fail" }
```

If no `authToken` is configured, the client is authenticated immediately on connect.

### Config

```json
// ~/.8gent/config.json
{
  "daemon": {
    "port": 18789,
    "authToken": "your-secret-token",
    "heartbeatIntervalMs": 1800000,
    "heartbeatEnabled": true
  }
}
```

## Session Lifecycle

Every client interaction happens within a session. A session holds an Agent instance with conversation history, tool access, and memory.

### Create Session

```
Client -> { "type": "session:create", "channel": "os" }
Server -> { "type": "session:created", "sessionId": "s_abc123_xyz" }
```

**Channels:** `"os"`, `"app"`, `"telegram"`, `"discord"`, `"api"`

The channel tag is metadata for routing and analytics. It does not change behavior.

### Resume Session

```
Client -> { "type": "session:resume", "sessionId": "s_abc123_xyz" }
Server -> { "type": "session:resumed", "sessionId": "s_abc123_xyz" }
```

If the session exists in the pool, its Agent instance is reused. If not (e.g. after daemon restart), a new Agent is created with the same session ID.

### Destroy Session

```
Client -> { "type": "session:destroy", "sessionId": "s_abc123_xyz" }
```

Frees the Agent instance from the pool.

### List Sessions

```
Client -> { "type": "sessions:list" }
Server -> {
  "type": "sessions:list",
  "sessions": [
    {
      "sessionId": "s_abc123_xyz",
      "channel": "os",
      "messageCount": 5,
      "createdAt": 1711100000000
    }
  ]
}
```

## Sending Prompts

### Request

```
Client -> { "type": "prompt", "text": "Fix the auth bug in login.ts" }
```

The client must have an active session (via `session:create` or `session:resume`). If not, the daemon responds with an error.

### Response Flow

The daemon processes the prompt asynchronously. As the agent works, the client receives a stream of events:

```
Server -> { "type": "event", "event": "agent:thinking", "payload": { "sessionId": "s_abc123_xyz" } }
Server -> { "type": "event", "event": "tool:start", "payload": { "sessionId": "s_abc123_xyz", "tool": "bash", "input": { "command": "cat login.ts" } } }
Server -> { "type": "event", "event": "tool:result", "payload": { "sessionId": "s_abc123_xyz", "tool": "bash", "output": "...", "durationMs": 42 } }
Server -> { "type": "event", "event": "agent:stream", "payload": { "sessionId": "s_abc123_xyz", "chunk": "I found the issue...", "final": true } }
Server -> { "type": "event", "event": "session:end", "payload": { "sessionId": "s_abc123_xyz", "reason": "turn-complete" } }
```

**Event types:**

| Event | Payload | Description |
|-------|---------|-------------|
| `agent:thinking` | `{ sessionId }` | Agent started processing |
| `tool:start` | `{ sessionId, tool, input }` | Tool invocation started |
| `tool:result` | `{ sessionId, tool, output, durationMs }` | Tool completed |
| `agent:stream` | `{ sessionId, chunk, final? }` | Text output. `final: true` on the complete response. |
| `agent:error` | `{ sessionId, error }` | Error during processing |
| `memory:saved` | `{ sessionId, key }` | Memory or evidence was saved |
| `approval:required` | `{ sessionId, tool, input, requestId }` | Agent needs permission for a destructive action |
| `session:end` | `{ sessionId, reason }` | Turn completed or session closed |

**End-of-turn reasons:** `"turn-complete"`, `"client-disconnect"`, `"client-destroy"`, `"idle-timeout"`

### Busy Guard

Only one prompt can be in-flight per session. If the agent is already processing, the daemon returns:

```
Server -> { "type": "event", "event": "agent:error", "payload": { "sessionId": "...", "error": "agent is busy processing another message" } }
```

## Cron Jobs

External clients can manage the daemon's cron scheduler.

### List Jobs

```
Client -> { "type": "cron:list" }
Server -> { "type": "cron:list", "jobs": [ { "id": "...", "name": "...", "expression": "*/30 * * * *", ... } ] }
```

### Add Job

```
Client -> {
  "type": "cron:add",
  "job": {
    "id": "daily-report",
    "name": "Daily status report",
    "expression": "0 9 * * *",
    "type": "agent-prompt",
    "payload": "Generate a daily status report",
    "enabled": true,
    "lastRun": null,
    "nextRun": null,
    "recurring": true
  }
}
Server -> { "type": "cron:added", "jobId": "daily-report" }
```

**Job types:** `"shell"` (runs command), `"agent-prompt"` (sends prompt to agent), `"webhook"` (POSTs to URL)

### Remove Job

```
Client -> { "type": "cron:remove", "jobId": "daily-report" }
Server -> { "type": "cron:removed", "jobId": "daily-report" }
```

## Health Check

### Via WebSocket

```
Client -> { "type": "health" }
Server -> {
  "type": "health",
  "data": {
    "status": "ok",
    "sessions": 2,
    "uptime": 3600.5,
    "cronJobs": 3
  }
}
```

### Via HTTP

```
GET http://localhost:18789/health
-> { "status": "ok", "sessions": 2, "uptime": 3600.5 }
```

## Keep-Alive

```
Client -> { "type": "ping" }
Server -> { "type": "pong" }
```

Clients should ping every 30 seconds to keep the connection alive.

## Error Handling

All errors are sent as:

```
Server -> { "type": "error", "message": "description of what went wrong" }
```

Common errors:
- `"not authenticated"` - auth required but client hasn't sent `auth` message
- `"invalid JSON"` - message couldn't be parsed
- `"no active session"` - tried to send prompt without creating/resuming a session
- `"unknown message type"` - unrecognized message type

## Session State Persistence

On graceful shutdown (SIGTERM/SIGINT), the daemon writes active session metadata to `~/.8gent/daemon-state.json`. On restart, clients can resume sessions by ID. The Agent instance is recreated, but conversation history must be restored from the client side or from memory.

Cron jobs persist to `~/.8gent/cron.json` and survive restarts. Missed jobs are caught up on startup (if gap exceeds 2x the interval).

## Ability Access

The 8 core abilities are accessible through the daemon indirectly via prompt-based interaction. The agent has full access to all abilities (memory, worktrees, policy, evolution, healing, entrepreneurship, AST, browser) when processing prompts.

**Currently daemon-accessible (via agent prompt):**
- Memory (agent can remember/recall during tool use)
- Orchestration (agent can spawn sub-agents)
- Policy (agent checks permissions on tool calls)
- Validation (agent uses checkpoint-verify-revert)
- AST (agent uses blast radius estimation)
- Browser (agent can fetch/search web)
- Proactive (agent can scan for opportunities)
- Evolution (agent reflects post-session)

**Not yet exposed as direct WebSocket APIs:**
- Direct memory read/write (bypassing agent)
- Worktree pool management
- Permission approval queue
- AST index queries
- Ability scorecard queries

These will be added in future protocol versions as the ecosystem matures.

## Client Implementation Guide

### Minimal Client (Bun/Node)

```typescript
const ws = new WebSocket("ws://localhost:18789");

ws.onopen = () => {
  // Auth if needed
  ws.send(JSON.stringify({ type: "session:create", channel: "app" }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case "session:created":
      // Session ready - send a prompt
      ws.send(JSON.stringify({ type: "prompt", text: "Hello Eight" }));
      break;

    case "event":
      if (msg.event === "agent:stream" && msg.payload.final) {
        console.log("Response:", msg.payload.chunk);
      }
      if (msg.event === "tool:start") {
        console.log("Tool:", msg.payload.tool);
      }
      break;

    case "error":
      console.error("Error:", msg.message);
      break;
  }
};
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-22 | Initial protocol - sessions, prompts, events, cron, health |
