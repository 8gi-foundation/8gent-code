# Quarantine: WebSocket Client Library

**Branch:** `quarantine/ws-client-lib`
**File:** `packages/daemon/client.ts`
**Size:** ~130 lines of logic

## What it does

Type-safe WebSocket client for connecting any frontend (TUI, CLUI, Lil Eight, web) to the Eight daemon at `ws://localhost:18789`.

## Features

- **Auto-reconnect** with exponential backoff (configurable base delay, max delay, max attempts, jitter)
- **Typed messages** - all inbound/outbound message types match the gateway protocol exactly
- **Event emitter** - `on()` returns an unsubscribe function, `onDaemonEvent()` filters by daemon event type
- **`waitFor()`** - promise-based helper that resolves when a specific message type arrives (with timeout)
- **Convenience methods** - `prompt()`, `createSession()`, `resumeSession()`, `health()`, `ping()`
- **Runtime-agnostic** - uses standard `WebSocket` API (works in Bun, Node 22+, browsers)

## Usage

```ts
import { EightClient } from "@8gent/daemon/client";

const client = new EightClient({ url: "ws://localhost:18789" });
client.connect();

client.on("open", () => {
  client.createSession("tui");
});

// Wait for session creation
const { sessionId } = await client.waitFor("session:created");

// Subscribe to agent stream chunks
client.onDaemonEvent("agent:stream", ({ chunk }) => {
  process.stdout.write(chunk);
});

// Send a prompt
client.prompt("What files changed today?");

// Cleanup
client.destroy();
```

## Graduation criteria

- [ ] Used by at least one frontend (TUI or CLUI)
- [ ] Integration test against a running daemon
- [ ] Reconnect behavior verified under network interruption
