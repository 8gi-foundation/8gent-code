# pubsub-emitter

**Tool name:** PubSub
**Package path:** `packages/tools/pubsub-emitter.ts`
**Status:** quarantine
**Lines:** ~110

## Description

Typed publish-subscribe event emitter for in-process async messaging. Supports wildcard topic patterns (`user.*`, `#`), once listeners that auto-remove after first fire, fully async emit (awaits all handlers in parallel), and event history replay for late subscribers.

## API

| Method | Signature | Notes |
|--------|-----------|-------|
| `subscribe` | `(pattern, handler, opts?)` | Returns unsubscribe fn |
| `once` | `(pattern, handler)` | Fires once, then removes |
| `unsubscribeAll` | `(pattern?)` | Clears one pattern or all |
| `emit` | `async (topic, event)` | Awaits all handlers, records history |
| `replay` | `(pattern, handler, opts?)` | Sends history entries to handler |
| `getHistory` | `(pattern?)` | Returns filtered history snapshot |

## Topic Pattern Rules

- `user.login` - exact match
- `user.*` - matches any single segment after `user.`
- `#` - matches everything

## Integration Path

1. **Orchestration bus** - wire into `packages/orchestration/` so sub-agents can broadcast state changes without direct references.
2. **Tool-call events** - emit `tool.start`, `tool.end`, `tool.error` from `packages/eight/agent.ts` so observability hooks subscribe without coupling.
3. **Memory consolidation** - `packages/memory/` fires `memory.added`, `memory.promoted`; kernel and reflection layers subscribe.
4. **Debugger** - `apps/debugger` subscribes to `#` and displays live event feed.

## Why Quarantine?

Solid utility but integration touch-points span 4+ packages. Needs scoped wiring plan before connecting to live systems. Validate wildcard matching and async error handling against real agent workloads first.
