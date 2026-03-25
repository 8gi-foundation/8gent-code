# quarantine/api-version

## Problem

Daemon Protocol has no versioning. Clients and server cannot negotiate capabilities, and there is no path for introducing breaking changes without silently breaking older clients.

## What this adds

`packages/daemon/api-versioning.ts` (~80 lines) provides:

1. **Version negotiation on connect** - client sends supported versions, server picks the highest common one. If no overlap, returns null so the gateway can reject.
2. **Backwards compatibility layer** - `shimOutbound()` and `shimInbound()` transform messages between protocol shapes so older clients keep working against the current server.
3. **Deprecation warnings** - deprecated versions are tracked with removal timeline notices. The negotiation result includes a `warning` field the gateway can forward to the client.

## Supported versions

| Version | Status | Notes |
|---------|--------|-------|
| 1.2 | Current | Latest protocol shape |
| 1.1 | Supported | Fully compatible with 1.2 today |
| 1.0 | Deprecated | `session:new` renamed to `session:create`, `result` renamed to `output` on tool events, no `channel` on session payloads. Removal planned for daemon 0.3.0. |

## Integration path

To wire this into the gateway:

1. On WebSocket `open`, read `Sec-WebSocket-Protocol` or an initial `version:negotiate` message from the client.
2. Call `negotiate(clientVersions)`. If null, close with 1002 (protocol error).
3. Store the negotiated `ProtocolVersion` on the client state.
4. Wrap `send()` calls with `shimOutbound(version, msg)`.
5. Wrap `handleMessage()` input with `shimInbound(version, msg)`.

## Not doing

- Modifying `gateway.ts` or any existing file (quarantine scope).
- Header-based negotiation (can be added when HTTP upgrade path is wired).
- Automatic version migration tooling.

## Success metric

Gateway can serve v1.0, v1.1, and v1.2 clients simultaneously without message shape errors, validated by unit tests against `negotiate()`, `shimOutbound()`, and `shimInbound()`.
