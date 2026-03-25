# Eight Daemon API Reference

Complete reference for the Eight daemon WebSocket and HTTP APIs.

**Protocol version:** 1.0
**Runtime:** Bun
**Default port:** 18789
**Deployment:** [eight-vessel.fly.dev](https://eight-vessel.fly.dev)

---

## HTTP Endpoints

### GET /health

Returns daemon status. No authentication required.

```
GET http://localhost:18789/health
```

**Response (200):**

```json
{
  "status": "ok",
  "sessions": 2,
  "uptime": 3600.5
}
```

### GET / (root)

Returns a plain-text identifier string.

```
GET http://localhost:18789/
```

**Response (200):**

```
Eight Daemon - ws://localhost:18789
```

---

## WebSocket Connection

**Endpoint:** `ws://localhost:18789`

All messages are JSON-encoded strings. Binary frames are decoded as UTF-8 before parsing.

### Connection Lifecycle

1. Client opens WebSocket to `ws://localhost:18789`
2. If `authToken` is configured, client must send `auth` before any other message
3. Client creates or resumes a session
4. Client sends prompts; server streams events back
5. On disconnect, the server emits `session:end` with reason `"client-disconnect"`

---

## Authentication

Authentication is optional. When `daemon.authToken` is set in `~/.8gent/config.json`, all messages except `auth` are rejected until the client authenticates.

### Configuration

```json
{
  "daemon": {
    "port": 18789,
    "authToken": "your-secret-token",
    "heartbeatIntervalMs": 1800000,
    "heartbeatEnabled": true
  }
}
```

**Config path:** `~/.8gent/config.json`

When `authToken` is `null` or absent, clients are authenticated immediately on connect.

### Auth Handshake

**Request:**

```json
{ "type": "auth", "token": "your-secret-token" }
```

**Success response:**

```json
{ "type": "auth:ok" }
```

**Failure response:**

```json
{ "type": "auth:fail" }
```

Sending any non-auth message before authenticating returns:

```json
{ "type": "error", "message": "not authenticated" }
```

---

## Inbound Message Types

All messages sent from client to server.

| Type | Required Fields | Description |
|------|----------------|-------------|
| `auth` | `token: string` | Authenticate the connection |
| `session:create` | `channel: string` | Create a new agent session |
| `session:resume` | `sessionId: string` | Reconnect to an existing session |
| `session:compact` | `sessionId: string` | Trigger context compaction |
| `session:destroy` | `sessionId: string` | Destroy a session and free its agent |
| `sessions:list` | - | List all active sessions |
| `prompt` | `text: string` | Send a prompt to the active session's agent |
| `approval:response` | `requestId: string`, `approved: boolean` | Respond to a permission request |
| `cron:list` | - | List all scheduled cron jobs |
| `cron:add` | `job: CronJob` | Add a new cron job |
| `cron:remove` | `jobId: string` | Remove a cron job by ID |
| `health` | - | Request daemon health status |
| `ping` | - | Keep-alive ping |

---

## Outbound Message Types

All messages sent from server to client.

| Type | Fields | Description |
|------|--------|-------------|
| `auth:ok` | - | Authentication succeeded |
| `auth:fail` | - | Authentication failed |
| `session:created` | `sessionId: string` | New session created |
| `session:resumed` | `sessionId: string` | Existing session resumed |
| `sessions:list` | `sessions: SessionInfo[]` | List of active sessions |
| `cron:list` | `jobs: CronJob[]` | List of cron jobs |
| `cron:added` | `jobId: string` | Cron job added |
| `cron:removed` | `jobId: string` | Cron job removed |
| `health` | `data: HealthData` | Daemon health status |
| `event` | `event: EventName`, `payload: object` | Agent event broadcast |
| `error` | `message: string` | Error message |
| `pong` | - | Keep-alive response |

---

## Session Management

### Channels

Sessions are tagged with a channel: `"os"`, `"app"`, `"telegram"`, `"discord"`, `"api"`.

The channel is metadata for routing and analytics. It does not change agent behavior, but it affects eviction policy - `"telegram"` and `"delegation"` sessions are never idle-evicted.

### Pool Limits

- **Max concurrent sessions:** 10
- **Idle timeout:** 30 minutes (non-telegram, non-delegation)
- **Cleanup interval:** every 5 minutes
- **Max tool turns per prompt:** 15 (default), 25 (delegation)

When the pool is full, the oldest idle session is evicted to make room.

### Session ID Format

```
s_{timestamp_base36}_{random_6chars}
```

Example: `s_lz5abc_k9m2x4`

### Create Session

```json
// Request
{ "type": "session:create", "channel": "app" }

// Response
{ "type": "session:created", "sessionId": "s_lz5abc_k9m2x4" }
```

### Resume Session

If the session exists in the pool, its agent is reused. If not (e.g., after daemon restart), a new agent is created with the same session ID.

```json
// Request
{ "type": "session:resume", "sessionId": "s_lz5abc_k9m2x4" }

// Response
{ "type": "session:resumed", "sessionId": "s_lz5abc_k9m2x4" }
```

### List Sessions

```json
// Request
{ "type": "sessions:list" }

// Response
{
  "type": "sessions:list",
  "sessions": [
    {
      "sessionId": "s_lz5abc_k9m2x4",
      "channel": "app",
      "messageCount": 5,
      "createdAt": 1711100000000
    }
  ]
}
```

### Destroy Session

```json
// Request
{ "type": "session:destroy", "sessionId": "s_lz5abc_k9m2x4" }
```

All clients attached to the destroyed session have their `sessionId` cleared. A `session:end` event is emitted with reason `"client-destroy"`.

---

## Sending Prompts

Requires an active session. Only one prompt can be in-flight per session.

```json
// Request
{ "type": "prompt", "text": "Fix the auth bug in login.ts" }
```

If no session is active:

```json
{ "type": "error", "message": "no active session" }
```

If the agent is already processing:

```json
{ "type": "event", "event": "agent:error", "payload": { "sessionId": "...", "error": "agent is busy processing another message" } }
```

---

## Event Types

Events are broadcast to all authenticated clients attached to the relevant session. They arrive wrapped in an `event` message:

```json
{ "type": "event", "event": "<EventName>", "payload": { ... } }
```

### agent:thinking

Agent started processing a prompt.

```json
{ "sessionId": "s_lz5abc_k9m2x4" }
```

### tool:start

Agent invoked a tool.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "tool": "bash", "input": { "command": "cat login.ts" } }
```

### tool:result

Tool execution completed.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "tool": "bash", "output": "...", "durationMs": 42 }
```

### agent:stream

Text output from the agent. Intermediate chunks have no `final` field. The complete response has `final: true`.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "chunk": "I found the issue in the auth middleware.", "final": true }
```

### agent:error

Error during agent processing.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "error": "model timeout after 30s" }
```

### memory:saved

A memory or evidence record was saved.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "key": "evidence:validation" }
```

### approval:required

Agent needs permission for a destructive action. Client should respond with `approval:response`.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "tool": "bash", "input": { "command": "rm -rf node_modules" }, "requestId": "req_abc123" }
```

### session:start

Session was created or resumed.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "channel": "app" }
```

### session:end

Session turn completed or session closed.

```json
{ "sessionId": "s_lz5abc_k9m2x4", "reason": "turn-complete" }
```

**Reasons:** `"turn-complete"`, `"client-disconnect"`, `"client-destroy"`, `"idle-timeout"`

---

## Approval Flow

When the agent encounters a destructive action that requires permission (governed by the NemoClaw policy engine), it emits `approval:required`. The client must respond:

```json
{ "type": "approval:response", "requestId": "req_abc123", "approved": true }
```

Set `approved: false` to deny the action.

---

## Cron Jobs

### CronJob Schema

```typescript
interface CronJob {
  id: string;           // Unique identifier
  name: string;         // Human-readable name
  expression: string;   // Cron expression or "once:ISO8601"
  type: "shell" | "agent-prompt" | "webhook";
  payload: string;      // Shell command, prompt text, or webhook URL
  enabled: boolean;
  lastRun: string | null;   // ISO 8601
  nextRun: string | null;   // ISO 8601
  recurring: boolean;
}
```

**Job types:**
- `shell` - runs a shell command via `sh -c`
- `agent-prompt` - queues a prompt for the agent
- `webhook` - POSTs to a URL

**Persistence:** Jobs are saved to `~/.8gent/cron.json` and survive daemon restarts. Missed jobs are caught up on startup if the gap exceeds 2x the cron interval.

### Add a Cron Job

```json
{
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
```

### One-Shot Jobs

Use `"once:ISO8601"` as the expression for single-execution jobs:

```json
{
  "expression": "once:2026-03-25T14:00:00Z",
  "recurring": false
}
```

---

## Keep-Alive

Clients should send a ping every 30 seconds.

```json
// Request
{ "type": "ping" }

// Response
{ "type": "pong" }
```

---

## Error Messages

All errors follow this format:

```json
{ "type": "error", "message": "description" }
```

| Error | Cause |
|-------|-------|
| `"not authenticated"` | Auth required but client has not sent `auth` |
| `"invalid JSON"` | Message could not be parsed |
| `"no active session"` | Prompt sent without creating/resuming a session |
| `"unknown message type"` | Unrecognized message type |
| `"invalid cron job: requires id, name, expression, type, payload"` | Cron job missing required fields |
| `"cron job {id} not found"` | Attempted to remove a non-existent job |

---

## TypeScript Client Example

Full client connecting, authenticating, creating a session, and handling events.

```typescript
const ws = new WebSocket("ws://localhost:18789");

ws.onopen = () => {
  // Step 1: Authenticate (skip if no authToken configured)
  ws.send(JSON.stringify({ type: "auth", token: "your-secret-token" }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case "auth:ok":
      // Step 2: Create a session
      ws.send(JSON.stringify({ type: "session:create", channel: "app" }));
      break;

    case "session:created":
      console.log("Session:", msg.sessionId);
      // Step 3: Send a prompt
      ws.send(JSON.stringify({ type: "prompt", text: "Hello Eight" }));
      break;

    case "event":
      // Step 4: Handle agent events
      switch (msg.event) {
        case "agent:thinking":
          console.log("Thinking...");
          break;
        case "tool:start":
          console.log(`Tool: ${msg.payload.tool}`);
          break;
        case "tool:result":
          console.log(`Result (${msg.payload.durationMs}ms)`);
          break;
        case "agent:stream":
          if (msg.payload.final) {
            console.log("Response:", msg.payload.chunk);
          }
          break;
        case "approval:required":
          // Auto-approve (or prompt user)
          ws.send(JSON.stringify({
            type: "approval:response",
            requestId: msg.payload.requestId,
            approved: true,
          }));
          break;
        case "session:end":
          console.log("Turn done:", msg.payload.reason);
          break;
      }
      break;

    case "error":
      console.error("Error:", msg.message);
      break;
  }
};

// Keep-alive
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 30_000);
```

---

## State Persistence

On graceful shutdown (SIGTERM/SIGINT), the daemon writes session metadata to `~/.8gent/daemon-state.json`. Clients can resume sessions by ID after restart.

Cron jobs persist to `~/.8gent/cron.json` independently and survive restarts.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-22 | Initial protocol - sessions, prompts, events, cron, health |
