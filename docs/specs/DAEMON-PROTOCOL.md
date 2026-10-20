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

**Bind and token.** The gateway listens on `127.0.0.1` unless `DAEMON_HOSTNAME` widens it (for example `0.0.0.0`). A non-loopback bind without `daemon.authToken` is refused at startup, with a message naming the two ways out: set `daemon.authToken`, or unset `DAEMON_HOSTNAME`. A loopback bind with no token works as before. Startup logs `[gateway] bind=<host> port=<port> auth=<on|off>`.

When a token is set, the root socket and `/store` and `/live/ws` require it in their first frame, as above. `/computer`, `/dispatch`, the pool status route, `/harnesses`, `/harness/*` and the Table speak route also require it at connect time, as `Authorization: Bearer <token>` or a `token` query parameter, and answer `401` without it. `/health` and `/audit/access` are unchanged.


## Session Lifecycle

Every client interaction happens within a session. A session holds an Agent instance with conversation history, tool access, and memory.

### Create Session

```
Client -> { "type": "session:create", "channel": "os" }
Server -> { "type": "session:created", "sessionId": "s_abc123_xyz" }
```

**Channels:** `"os"`, `"app"`, `"telegram"`, `"discord"`, `"api"`, `"delegation"`, `"computer"`, `"browser"`, `"classroom"`

The channel tag is metadata for routing, concurrency caps, and analytics.

**Per-channel limits** (override via env):

| Channel | Concurrency cap | Idle timeout | Notes |
|---------|-----------------|--------------|-------|
| `computer` | 3 (`MAX_COMPUTER_SESSIONS`) | 10 min | Loopback-only in v0 |
| `telegram` | unlimited (within global cap) | never evicted | Sandbox-style persistence |
| `delegation` | unlimited | never evicted | Sub-agent fan-out |
| `classroom` | 3 | 5 min | No tools, private, not saved (see Classroom Channel) |
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

## Shared Sessions (v1.4)

One session, many surfaces (#3929): the TUI, the 8gent Browser panel and any other
loopback client can list sessions, join one live, and bring a past one back. Every
client bound to a session already receives its events; these frames add discovery,
a transcript on join, an echo of what other clients send, and a Stop that does not
end the session.

All four requests need an authenticated connection (the token, when
`daemon.authToken` is set) **and** a loopback peer, checked per frame:
`{ "type": "error", "message": "shared sessions are loopback-only" }` otherwise.
Session ids must match `^[A-Za-z0-9_-]{1,64}$` before any disk access.
Only the `tui`, `os`, `app`, `api` and `browser` channels are listed, attached,
stopped or saved; telegram, table, delegation and computer sessions stay private.

### List

```
Client -> { "type": "session:list", "past": true, "limit": 20 }   // past defaults true; limit 1..100
Server -> {
  "type": "session:list",
  "live": [ { "sessionId": "s_lz1_ab12cd", "channel": "tui", "title": "auth bug", "busy": false,
              "messageCount": 6, "clients": 2, "createdAt": 1789300000000, "lastActiveAt": 1789300100000 } ],
  "past": [ { "sessionId": "ebeb469c", "channel": "tui", "title": "Session 2026-10-11", "messageCount": 15,
              "model": "eight:latest", "cwd": "/Users/me/project", "lastActiveAt": 1789300000000 } ]
}
```

`past` comes from `~/.8gent/sessions/<id>.json` (`$EIGHT_DATA_DIR/sessions` when set),
the store the TUI saves to; ids already live are not repeated.

### Attach

```
Client -> { "type": "session:attach", "sessionId": "ebeb469c", "channel": "browser" }
Server -> { "type": "session:attached", "sessionId": "ebeb469c", "channel": "tui", "busy": false,
            "restored": true, "transcript": [ { "role": "user", "content": "..." } ], "truncated": false }
```

- A live id binds this connection to it.
- A past id is created in the pool on its saved channel (a file with none was written by
  the TUI, so `tui`) and in its saved `cwd` when that directory exists, its user/assistant
  messages are restored into the agent, and the connection is bound (`restored: true`).
- `channel` names the attaching surface; it labels this client's `user:message` echoes.
- The transcript is the last 200 user/assistant messages, each capped at 20,000 chars.
- Errors: `invalid session id`, `session not found`, `session cannot be shared`.

### Detach

```
Client -> { "type": "session:detach" }
Server -> { "type": "session:detached", "sessionId": "s_..." }
```

The session keeps running for the other clients; no `session:end` is emitted.

### Abort (shared-safe Stop)

```
Client -> { "type": "session:abort", "sessionId": "s_..." }   // defaults to the bound session
Server -> { "type": "session:aborted", "sessionId": "s_...", "aborted": true }
```

Stops the turn in flight; the session and its history stay. Use it instead of
`session:destroy`, which ends the session for every client on it.

### Echo of other clients' prompts

```
Server -> { "type": "event", "event": "user:message", "payload": { "sessionId": "s_...", "text": "...", "channel": "tui" } }
```

Sent to every other client bound to the session when one sends `prompt`. The sender is not echoed.

### Behaviour that changed with v1.4

- A client disconnecting emits `session:end { reason: "client-disconnect" }` only when no
  other client is still bound to that session.
- After every turn on a shared session the daemon saves the user/assistant history to the
  session store (SessionManager format plus `channel`; harness notes and the planning gate are
  left out), so the TUI and a later `session:attach` can resume it after a daemon restart.
- Approvals are unchanged: `approval:*` still reaches only the registered approval bridge, and a
  prompt from an attached client runs with no approval turn.
- `sessions:list` (v1.0) is unchanged.
- `session:resume` follows the same rules. A live telegram session is resumed only by the
  registered approval bridge; table, delegation and computer sessions never. Joining a live
  session other clients are on needs a loopback peer. A session that is not live but has a
  saved file is restored from it, with its history and channel (loopback only), instead of
  being recreated empty under that id.
- Resume secrets: `session:created`, `session:attached` and `session:resumed` carry
  `"resumeSecret": "<32 hex>"`, one per session. A `session:resume` from a non-loopback peer
  of a live session must send it back as `"resumeSecret"`, otherwise
  `{ "type": "error", "message": "resume secret required" }`. Loopback clients may omit it.
- `session:create` takes an optional `"persist": true` (shareable channels only): the session
  is saved after every turn from the start, so a chat only one surface ever had can be resumed
  later, also after a daemon restart. Without it (older clients) nothing changes.
- `session:destroy` only ends the session the connection is on
  (`can only end the session you are on` otherwise). When other clients are on it, it only
  takes this client off, like `session:detach`.
- `session:abort` only stops the connection's own session.
- Only shared sessions are saved: restored from a file, or attached to when no file with
  that id exists. A session never writes over a file it was not restored from. Files are 0600.
- A restore from disk is refused when the pool has no room (no idle, unattached session to
  make way), and is limited to 5 per connection per minute. A session with a client attached
  is never evicted for idleness or room, and a cap eviction always emits `session:end`.
- The store is `$EIGHT_DATA_DIR/sessions` when set, else `~/.8gent/sessions`, for both the
  daemon and the TUI.

## Classroom Channel (v1.5)

8gent Browser builds lessons from text on the open web, which is untrusted. The
`classroom` channel (#3939) is a session that cannot act on it.

```
Client -> { "type": "session:create", "channel": "classroom" }
Server -> { "type": "session:created", "sessionId": "s_...", "resumeSecret": "<32 hex>" }
```

- **Who may create one:** a loopback peer. When `daemon.authToken` is set it is enforced like any frame (`not authenticated` before auth).
  A non-loopback peer gets `{ "type": "error", "message": "classroom sessions are loopback-only" }`.
  The session ends when the socket that created it closes.
- **No tools at all.** The model is offered none (no file, shell, network or browser tools,
  no delegation, no memory writes), the pre-fetch router is off, the executor refuses any
  call for the `__classroom__` scope, and a `*` block rule backs it in the policy engine.
  A caller cannot widen this: `agentScope`, `systemPrompt` and `maxTurns` overrides are ignored.
- **Fixed system prompt:** the user message is untrusted data to teach from, never
  instructions, and the reply is exactly one JSON object.
- **Short:** at most 2 model rounds per turn, idle sessions are dropped after 5 minutes,
  at most 3 at once.
- **Private to its connection:** not listed (`sessions:list`, `session:list`), and
  `session:attach`, `session:resume` and `session:abort` answer `session cannot be shared`
  for every client, the creator included. `persist: true` is ignored and nothing is
  written to the session store.

## Session Time-Travel

Rewind and fork verbs over the content-addressed checkpoint store
(`packages/eight/timetravel/checkpoint-store.ts`). The agent cuts a checkpoint
every `EIGHT_CHECKPOINT_EVERY` executed tool calls (default 8, `0` disables),
so any session can be rewound to an earlier state or forked to explore two
fixes from the same state. Everything stays local under `~/.8gent/timetravel`
(relocatable via `EIGHT_TIMETRAVEL_DIR`).

All three verbs default to the connection's bound session when `sessionId`
is omitted. Failures come back as a standard `{ "type": "error" }` frame.

### List Checkpoints

```
Client -> { "type": "timetravel:list", "sessionId": "s_abc123_xyz" }
Server -> {
  "type": "timetravel:list",
  "sessionId": "s_abc123_xyz",
  "checkpoints": [
    {
      "id": "cp_mc0abc_0_k2f9",
      "parentId": null,
      "forkedFrom": null,
      "reason": "interval",        // "interval" | "phase" | "manual" | "fork"
      "toolCallCount": 8,
      "messageCount": 12,
      "createdAt": 1789300000000
    }
  ]
}
```

Checkpoints are ordered oldest first. Content hashes are not exposed on the
wire; frames stay small regardless of history size.

### Rewind

```
Client -> { "type": "timetravel:rewind", "sessionId": "s_abc123_xyz", "steps": 1 }
Server -> {
  "type": "timetravel:rewound",
  "sessionId": "s_abc123_xyz",
  "steps": 1,
  "checkpoint": { ... },           // summary of the restored checkpoint
  "messageCount": 12
}
```

`steps` defaults to `1` (one checkpoint back). `steps: 0` restores the latest
checkpoint. The live agent's message history is replaced in place; the next
`prompt` continues from the restored state. Rewinding past the oldest
checkpoint returns an error and leaves the agent untouched.

### Fork

```
Client -> { "type": "timetravel:fork", "sessionId": "s_abc123_xyz", "checkpointId": "cp_mc0abc_0_k2f9" }
Server -> {
  "type": "timetravel:forked",
  "sessionId": "s_new456_abc",     // the fork's session id
  "sourceSessionId": "s_abc123_xyz",
  "forkedFrom": "cp_mc0abc_0_k2f9",
  "checkpoint": { ... },
  "messageCount": 12
}
```

`checkpointId` defaults to the source session's latest checkpoint. `channel`
is optional and defaults to the connection's channel. The daemon creates a new
pool session seeded from the checkpoint (zero blobs copied - the store is
content-addressed) and rebinds the client connection to the fork, so the next
`prompt` runs on the forked lineage. The source session keeps running
independently: explore two fixes from the same state.

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
| `tool:start` | `{ sessionId, tool, input, toolCallId? }` | Tool invocation started |
| `tool:result` | `{ sessionId, tool, output, durationMs, toolCallId?, success? }` | Tool completed. `toolCallId` pairs it with its start; `success` is false when the tool failed (#4190) |
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

## Live Anatomy View (`/live`, #4190)

A loopback page that draws the daemon's sessions as a Mermaid graph, rebuilt from bus events
(`packages/daemon/live-anatomy.ts`). No model is in the path: `buildLiveGraph(events)` is pure.

- `GET /live` serves the page; `GET /live/mermaid.js` serves Mermaid from the daemon's own
  `node_modules` (no CDN). Both answer loopback peers only, whatever `DAEMON_HOSTNAME` binds to.
- `ws://127.0.0.1:<port>/live/ws` is the feed, loopback-only. The page sends one frame,
  `{ "type": "live:watch", "token"?: "...", "session"?: "<id>" }`; the token is required when
  the daemon has one (the TUI passes it in the URL fragment). The daemon answers with
  `{ "type": "live:graph", "mermaid": "...", "nodes": [...] }` now and on every event.
- Only shareable channels (`tui`, `os`, `app`, `api`, `browser`) are drawn; telegram, table,
  delegation, computer and classroom sessions never reach the page. Every payload string is
  scrubbed by `secret-scanner` before it is stored. Raw events, approval request ids and chat ids
  never leave the daemon.
- Nodes: the session, files touched (grouped by folder), shell commands, other tools. State per
  node from its latest call: running (green), paused (amber, waiting on an approval), failed
  (red), done (grey).
- The TUI opens it with Ctrl+F (in 8gent Browser when its control channel answers; the URL is
  always printed).

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

### Resume on boot and durable turns

With `EIGHT_RESUME_ON_BOOT=1`, every open session is journaled to
`~/.8gent/sessions-journal.json` (atomic write, owner-only) and recreated on
the next start from its newest time-travel checkpoint. A tool call that was
running at the crash is re-run only if it is a read; anything else is reported
to the model as not replayed. The journal also holds the turn that was running
(`pendingTurn`: the user text, scrubbed and capped, plus an attempt count),
written before the daemon shows anything for that turn and dropped when the
turn ends.

With `EIGHT_AUTO_CONTINUE=1` as well (default off), a session whose last turn
started and never finished is continued once, automatically, after the restore
and the replay settle. The attempt is journaled before the continuation runs,
so a second crash during it abandons the turn instead of looping. When the
interrupted call was a write or command, the session stays at the pre-tool
checkpoint the restore put back and the continuation tells the model to verify
what took effect before changing anything. The pending turn's text is capped
at 4000 characters on write and again on read, so a hand-edited journal cannot
feed the model an oversized prompt. The original turn's approval context does
not survive the restart: a continuation of a Telegram-started turn has no
operator to ask, so a gated command in it is denied (fail closed) and the
continuation note tells the model to leave such commands for the user.
`scripts/durable-continue-demo.ts` is the kill -9 demonstration.

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

Every `desktop_*` tool call goes through `evaluatePolicy("desktop_use", ctx)` in `packages/permissions/policy-engine.ts`. The first `click`, `type`, `press`, `drag`, or `clipboard_set` of a session triggers `approval_required`. Read-only actions (`screenshot`, `window_list`, `display_list`, `hover`, `scroll`, `clipboard_get`, `list_processes`, `suggest_quit`, `safe_list`) are allowed without prompt. Dangerous key combinations (`cmd+q`, `alt+f4`, `ctrl+alt+delete`, `cmd+shift+q`) are hard-blocked. `quit_app` always requires approval, and a desktop action no rule covers asks rather than running (the `desktop_use` default is ask, not allow). The agent's own `ToolExecutor` gates `desktop_*` under the same `desktop_use` name and descriptor (`packages/computer/desktop-policy.ts`); with no person to ask it refuses (#3213).

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
| `browser` (8gent-browser desktop app) | `read`, `write_basic` (write_full requires second-factor on the originator) |
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

## Goal-Loop Methods

The `/goal` feature wraps an existing agent session in an outer loop driven by a
separate judge model. RPC methods travel on the default gateway WebSocket
(same channel as `prompt` and `session:*`). All goal-loop messages share a
`goal.*` type prefix. Implementation: `packages/goal/` (pure logic),
`packages/daemon/goal-rpc.ts` (manager + handlers).

### Methods

#### `goal.start`

```
Client -> {
  "type": "goal.start",
  "sessionId": "s_xyz",
  "goal": "make the failing auth tests pass",
  "budget": {
    "turns": 8,
    "tokens": 60000,
    "wallclockMs": 600000,
    "maxDissentStreak": 6
  },
  "executorModel": "qwen3.5:14b",   // optional hint
  "judgeModel": "deepseek-v4-flash" // optional hint; MUST differ from executor
}

Server -> { "type": "goal.started", "runId": "g_xxx_yyy" }
```

`budget` is optional; defaults are defined in `packages/goal/types.ts`
(`DEFAULT_BUDGET`). Constructor rejects identical executor + judge models with
`goal.error`.

#### `goal.status`

```
Client -> { "type": "goal.status", "runId": "g_xxx_yyy" }

Server -> {
  "type": "goal.status",
  "runId": "g_xxx_yyy",
  "snapshot": {
    "runId": "g_xxx_yyy",
    "sessionId": "s_xyz",
    "goal": "...",
    "status": "running",         // pending | running | judging | completed | stopped | failed
    "stopReason": null,           // set on terminal status
    "lastVerdict": { ... } | null,
    "counters": { "turns": 3, "tokens": 18204, ... },
    "receipt": { ... } | null,    // present only on terminal status
    "startedAt": 1731700000000,
    "endedAt": null
  }
}
```

`snapshot` is `null` when the runId is unknown to the manager.

#### `goal.subgoal`

```
Client -> { "type": "goal.subgoal", "runId": "g_xxx_yyy", "text": "focus on the JWT verifier" }
Server -> { "type": "goal.subgoal:ok", "runId": "g_xxx_yyy", "accepted": true }
```

The subgoal is consumed by the next executor turn. The current in-flight turn
completes first; subgoals never preempt.

#### `goal.abort`

```
Client -> { "type": "goal.abort", "runId": "g_xxx_yyy" }
Server -> { "type": "goal.abort:ok", "runId": "g_xxx_yyy", "accepted": true }
```

Cooperative. The executor's `abort()` is called; the run terminates with
`stopReason: "user_abort"`.

#### `goal.resume`

```
Client -> { "type": "goal.resume", "runId": "g_xxx_yyy" }
Server -> { "type": "goal.resume:ok", "runId": "g_xxx_yyy", "known": true }
```

Scaffold version: returns whether the manager still holds the run in memory.
Full ledger replay (post-daemon-restart recovery) is owned by 8GO and ships in
a follow-up.

#### `goal.error`

Any goal RPC may return `{ "type": "goal.error", "message": "..." }` instead
of its success envelope (bad arguments, unknown method, executor factory
failure, etc.). Clients should treat any `goal.error` as terminal for the
request that triggered it.

### Streaming events

Per-turn progress flows over the existing `event` envelope. Event `event`
names are the `GoalEventKind` values from `packages/goal/types.ts`:

| Event kind | When | Payload highlights |
|---|---|---|
| `goal.turn` (`turn.requested` / `turn.completed`) | Executor takes a turn | `turn`, `summary`, `tokensIn`, `tokensOut`, `subgoal` |
| `goal.judge` (`judge.requested` / `judge.verdict`) | Judge scores a turn | `decision`, `confidence`, `summary` |
| `goal.done` (`run.completed` / `run.stopped` / `run.failed`) | Terminal transition | `status`, `stopReason`, `finalVerdict` |
| `subgoal.injected` | `goal.subgoal` accepted | `text` |
| `budget.tripped` | Cap hit | `reason` (`budget_turns` / `budget_tokens` / etc.) |

Each event carries `runId` + monotonic `seq` for ordering. Sinks for the
event stream (SQLite mirror, HMAC append-only file) are owned by 8GO; the
goal package only emits in-memory `GoalEvent` records.

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.5 | 2026-10-11 | Add the restricted `classroom` channel: no tools, loopback + token only, private, not persisted. (#3939) |
| 1.4 | 2026-10-11 | Shared sessions: `session:list` / `session:attach` / `session:detach` / `session:abort`, `user:message` echo, disconnect only ends a session for the last client, shareable sessions saved to the session store. (#3929) |
| 1.3 | 2026-05-16 | Add goal-loop methods (`goal.start` / `goal.status` / `goal.subgoal` / `goal.abort` / `goal.resume`) + streaming event taxonomy. Schema v2 (`goal_runs`, `goal_events`). (#2606) |
| 1.2 | 2026-04-26 | Add remote dispatch protocol (`/dispatch` route). Surface registration, replay protection, rate limiting, capability scoping, fan-out to `replay_to` subscribers, `dispatch_source` in trace records. (#1896) |
| 1.1 | 2026-04-25 | Add `computer` channel, dedicated `/computer` route, streaming event taxonomy (`token`/`tool_call`/`tool_result`/`approval_required`/`error`/`done`), `protocol_version: 1` on every frame, `/ops/agent-pool/status` endpoint. |
| 1.0 | 2026-03-22 | Initial protocol - sessions, prompts, events, cron, health |
