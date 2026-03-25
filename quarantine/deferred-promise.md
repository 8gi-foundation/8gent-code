# Quarantine: deferred-promise

## Tool Name

`deferred-promise`

## Description

Externally resolvable promise for async coordination. Exposes `Deferred<T>` - a promise whose `resolve` and `reject` handles live outside the executor. Supports timeout auto-rejection and multi-deferred racing.

Exports:
- `deferred<T>()` - base factory
- `deferredWithTimeout<T>(ms, message?)` - auto-rejecting variant
- `raceDeferred<T>(deferreds[])` - race helper
- `Deferred<T>` - TypeScript interface

## Status

**quarantine** - implemented, not yet wired into the agent loop or tool registry.

## Why Quarantine

No immediate call site exists yet. The pattern is needed when wiring:
- Agent tool call responses to streaming events
- Worktree-to-worktree coordination gates
- Timeout-enforced sub-agent delegation

Shipping it now without a call site would be speculative. Quarantine lets it exist without blast radius.

## Integration Path

1. **Tool call coordination** - `packages/eight/agent.ts` tool loop can use `deferredWithTimeout` to enforce per-tool time limits.
2. **Worktree messaging** - `packages/orchestration/` filesystem message bus can use `deferred` as a receive gate instead of polling.
3. **Daemon protocol** - `packages/daemon/` WebSocket handlers can use `deferred` to await streamed responses per session.

## File

`packages/tools/deferred-promise.ts` (~140 lines, zero dependencies)

## Integration Checklist

- [ ] Identify first real call site (agent loop or orchestration)
- [ ] Add to tool registry or export barrel (`packages/tools/index.ts`) when wired
- [ ] Write integration test at call site
- [ ] Remove from quarantine once merged into active code path
