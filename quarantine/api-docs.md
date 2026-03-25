# Quarantine: API Reference Documentation

## What

Comprehensive API reference for the Eight daemon WebSocket and HTTP APIs at `docs/API-REFERENCE.md`.

## Why

The existing `docs/DAEMON-PROTOCOL.md` serves as a protocol specification. The API reference provides a developer-facing document with complete message schemas, payload examples, error tables, and a full TypeScript client example - easier to consume when building integrations.

## Files

- `docs/API-REFERENCE.md` - full API reference (~240 lines)
- `quarantine/api-docs.md` - this file

## Source Material

Built from reading:
- `packages/daemon/gateway.ts` - all inbound/outbound message types, auth flow, handler logic
- `packages/daemon/events.ts` - typed event bus with all `DaemonEvents`
- `packages/daemon/agent-pool.ts` - session pool limits, idle eviction, busy guard
- `packages/daemon/cron.ts` - job schema, persistence, catchup logic
- `docs/DAEMON-PROTOCOL.md` - existing protocol spec

## Coverage

- All 13 inbound message types
- All 12 outbound message types
- HTTP health endpoint and root endpoint
- Authentication flow with config example
- Session lifecycle (create, resume, destroy, list)
- Pool limits and eviction policy
- All 9 event types with payload schemas
- Approval flow
- Cron job schema with one-shot support
- Error message table
- Full TypeScript client example
- State persistence behavior

## Status

Ready for review. No existing files modified.
