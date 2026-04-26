# Daemon Protocol v1.1

WebSocket protocol for external clients connecting to the Eight daemon.

This is the contract between the brain (8gent Code daemon) and the interfaces (8gent.app, 8gent OS, Telegram, the 8gent Computer NSPanel, etc.).

Protocol version is carried explicitly on every server-to-client frame as `"protocol_version": 1`. Clients must reject frames whose `protocol_version` they do not support.

---

## Connection

**Default endpoint:** `ws://localhost:18789` (multiplexed gateway)
**Computer-channel endpoint:** `ws://localhost:18789/computer` (dedicated route, loopback-only in v0)
**Health check:** `GET http://localhost:18789/health`
**Pool status (per channel):** `GET http://localhost:18789/ops/agent-pool/status`

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

**Channels:** `"os"`, `"app"`, `"telegram"`, `"discord"`, `"api"`, `"delegation"`, `"computer"`

The channel tag is metadata for routing, concurrency caps, and analytics.

**Per-channel limits** (override via env):

| Channel | Concurrency cap | Idle timeout | Notes |
|---------|-----------------|--------------|-------|
| `computer` | 3 (`MAX_COMPUTER_SESSIONS`) | 10 min | Loopback-only in v0 |
| `telegram` | unlimited (within global cap) | never evicted | Sandbox-style persistence |
| `delegation` | unlimited | never evicted | Sub-agent fan-out |
| other | global cap (10) | 30 min | |

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

## Computer Channel (`/computer`)

The 8gent Computer surface (voice-first ambient agent) connects on a dedicated route so it gets its own session pool, idle behavior, and event taxonomy that does not have to share the multiplexed root socket.

### Connect

```
GET /computer  HTTP/1.1
Upgrade: websocket
```

The daemon rejects non-loopback peers on this route in v0 (`HTTP 403`). Set `DAEMON_HOSTNAME=127.0.0.1` to additionally lock the listener bind.

On connect, the daemon auto-creates a session and emits an ack:

```json
{
  "protocol_version": 1,
  "type": "ack",
  "payload": { "type": "session:created", "sessionId": "s_lzf8x9_ab12c3", "channel": "computer" }
}
```

### Inbound messages (client -> daemon)

```json
{ "type": "intent", "text": "screenshot my desktop and tell me what's open" }
{ "type": "approval:response", "requestId": "r_xyz", "approved": true }
{ "type": "session:destroy" }
{ "type": "ping" }
```

### Streaming event taxonomy (daemon -> client)

Every event frame is wrapped:

```json
{ "protocol_version": 1, "type": "event", "event": { "kind": "...", ... } }
```

**Event kinds:**

| Kind | Shape | Description |
|------|-------|-------------|
| `token` | `{ kind, sessionId, chunk, final? }` | Streaming text. `final: true` marks the last chunk of a turn. |
| `tool_call` | `{ kind, sessionId, tool, input, callId }` | Tool invocation started. `callId` pairs with the matching `tool_result`. |
| `tool_result` | `{ kind, sessionId, tool, output, callId, durationMs }` | Tool finished. |
| `approval_required` | `{ kind, sessionId, tool, input, requestId, reason? }` | NemoClaw `require_approval` hit. Client must reply with `approval:response`. |
| `error` | `{ kind, sessionId, error, recoverable? }` | Per-turn error. Connection stays open unless `recoverable: false`. |
| `done` | `{ kind, sessionId, reason }` | Turn or session ended. `reason` is one of `turn-complete`, `client-disconnect`, `client-destroy`, `idle-timeout`, `channel-cap-evict`. |

**Backpressure:** the protocol is JSON-only for control and text events. Binary frames are reserved for future PNG payloads (e.g. inline screenshots). Today, screenshots are returned as filesystem paths inside `tool_result.output` so the client can read them without flooding the WS buffer.

**Approval flow:**

```
daemon -> { "type":"event", "event": { "kind":"approval_required", "tool":"desktop_click", "requestId":"r_42", ... } }
client -> { "type":"approval:response", "requestId":"r_42", "approved":true }
daemon -> { "type":"event", "event": { "kind":"tool_call", ... } }
```

### NemoClaw policy (no bypass)

Every `desktop_*` tool call goes through `evaluatePolicy("desktop_use", ctx)` in `packages/permissions/policy-engine.ts`. The first `click`, `type`, `press`, `drag`, or `clipboard_set` of a session triggers `approval_required`. Read-only actions (`screenshot`, `window_list`, `display_list`, `hover`, `scroll`, `clipboard_get`, `list_processes`, `suggest_quit`, `safe_list`) are allowed without prompt. Dangerous key combinations (`cmd+q`, `alt+f4`, `ctrl+alt+delete`, `cmd+shift+q`) are hard-blocked.

The headless CLI uses the same path; the policy gate is **never** bypassed.

### Smoke test

```bash
bun run packages/daemon/scripts/smoke-computer-channel.ts
```

The script boots a stripped-down gateway against a mock pool, connects to `/computer`, sends one intent, and asserts the event ordering: `tool_call` -> `tool_result` -> `token{final:true}` -> `done`.

## Dispatch Protocol (`/dispatch`)

The dispatch protocol is the nervous system of 8gentOS. It lets any 8gent surface (Code TUI, Telegram bot, Discord bot, OS web, Computer panel, mobile, future) target a session on any other surface. The daemon is always the trusted executor; surfaces are observers and originators.

**Endpoint:** `ws://<host>:<port>/dispatch`
**Issue:** [#1896](https://github.com/8gi-foundation/8gent-code/issues/1896)

### Surface registration

Every surface must register before dispatching. The token is verified against the configured `TokenVerifier` (local HMAC by default; Clerk JWT for the `os`/`app` channels via a composed verifier).

```
Client -> {
  "type": "dispatch:register",
  "token": "<scoped-token>",
  "surface_id": "tg_bot_main"
}

Server -> {
  "protocol_version": 1,
  "type": "dispatch:registered",
  "surface_id": "tg_bot_main",
  "channel": "telegram",
  "capabilities": ["read", "write_basic"]
}
```

The token's claims fully determine the surface's `(user_id, channel, capabilities)`. The daemon intersects claimed capabilities with the channel's default capability table - a token can never grant more than the channel allows.

### Default capability table

| Channel | Default capabilities |
|---------|----------------------|
| `computer` (Mac panel, locally authed) | `read`, `write_basic`, `write_full`, `admin` |
| `os` (Clerk-authed web) | `read`, `write_basic`, `write_full`, `admin` |
| `app` | `read`, `write_basic`, `write_full` |
| `telegram` | `read`, `write_basic` (write_full requires second-factor on the originator) |
| `discord` | `read`, `write_basic` (write_full requires second-factor on the originator) |
| `delegation` | `read`, `write_basic`, `write_full` |
| `api` | scope per token grant (caller controls) |

Per-tenant overrides are documented in the user's settings.

### Dispatch send

```
Client -> {
  "type": "dispatch:send",
  "dispatch_id": "<monotonic-per-token>",
  "originating_channel": "telegram",
  "target_channel": "computer",
  "target_surface_id": null,
  "correlation_id": "c_xyz",
  "replay_to": ["telegram", "os"],
  "intent": "screenshot my desktop and tell me what's open",
  "capability_required": "write_basic"
}

Server -> {
  "protocol_version": 1,
  "type": "dispatch:ack",
  "dispatch_id": "<...>",
  "correlation_id": "c_xyz",
  "ok": true,
  "session_id": "disp_xyz",
  "target_channel": "computer",
  "target_surface_id": null
}
```

`target_channel` may be set to `"auto"` to dispatch to the user's most recently active surface, or `target_surface_id` may be set to a specific registered surface_id (cross-tenant dispatch is forbidden).

### Streaming events

The router emits an `accepted` event immediately on success, then bridges agent-pool events into `dispatch:event` frames:

```
Server -> {
  "protocol_version": 1,
  "type": "dispatch:event",
  "dispatch_id": "<...>",
  "correlation_id": "c_xyz",
  "originating_channel": "telegram",
  "target_channel": "computer",
  "dispatch_source": "telegram",
  "event": { "kind": "tool_call", "tool": "desktop_screenshot", "input": {...} }
}
```

**Event kinds:** `accepted`, `stream`, `tool_call`, `tool_result`, `error`, `done`. Every event carries the `dispatch_source` field so the trace viewer (#1869) can show full provenance.

### Subscribing to a dispatch from a peer surface

Peer surfaces declared in `replay_to` receive the same events when they subscribe by `correlation_id`:

```
Client -> { "type": "dispatch:subscribe", "correlation_id": "c_xyz" }
Server -> { "protocol_version": 1, "type": "dispatch:subscribed", "correlation_id": "c_xyz" }
```

### Replay protection

The daemon maintains a per-token sliding-window ledger (default 5 min, max 1000 entries). A duplicate `dispatch_id` within the window is rejected:

```
Server -> {
  "type": "dispatch:ack",
  "dispatch_id": "<...>",
  "correlation_id": "<...>",
  "ok": false,
  "code": "replay_detected",
  "error": "dispatch_id replayed within window"
}
```

### Rate limiting

Default 100 dispatches/minute/token, configurable. Rejected dispatches return:

```
Server -> {
  "type": "dispatch:ack",
  "ok": false,
  "code": "rate_limited",
  "retry_after_ms": 12345
}
```

### Capability + policy denial

```
Server -> {
  "type": "dispatch:ack",
  "ok": false,
  "code": "capability_denied",
  "error": "dispatches with capability \"write_full\" from \"telegram\" require second-factor approval"
}
```

The originating surface should prompt the user for second-factor approval, then re-dispatch with a fresh `dispatch_id`.

### Audit trail

Every dispatch event flows into `packages/memory/computer-use-traces.ts` with the `dispatch_source` field populated. This is the same ring buffer that the broader trace viewer (#1868/#1869) consumes - dispatch traces appear alongside tool-use and agent-step traces with consistent provenance.

### Authentication for remote surfaces

Local-machine surfaces (Computer panel, lil-eight, local Telegram bridge) use HMAC-signed scoped tokens minted from a per-process secret (`EIGHT_DISPATCH_SECRET`).

Remote surfaces (`os`/`app` web sessions) authenticate via Clerk JWT - the daemon composes a `CompositeTokenVerifier` so a single dispatch listener accepts both schemes.

```ts
import { CompositeTokenVerifier, LocalTokenVerifier } from "@8gent/daemon/dispatch";

const verifier = new CompositeTokenVerifier([
  new LocalTokenVerifier(process.env.EIGHT_DISPATCH_SECRET!),
  new ClerkJWTVerifier({ jwksUri: "..." }),  // app code provides this
]);
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.2 | 2026-04-26 | Add remote dispatch protocol (`/dispatch` route). Surface registration, replay protection, rate limiting, capability scoping, fan-out to `replay_to` subscribers, `dispatch_source` in trace records. (#1896) |
| 1.1 | 2026-04-25 | Add `computer` channel, dedicated `/computer` route, streaming event taxonomy (`token`/`tool_call`/`tool_result`/`approval_required`/`error`/`done`), `protocol_version: 1` on every frame, `/ops/agent-pool/status` endpoint. |
| 1.0 | 2026-03-22 | Initial protocol - sessions, prompts, events, cron, health |
