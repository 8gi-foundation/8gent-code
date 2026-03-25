# event-sourcing-store

## Tool Name
`EventStore` - Event Sourcing Store

## Description
Append-only event log that rebuilds application state through event replay. Supports snapshots for fast recovery and time-travel to any sequence or timestamp. Designed for agent session debugging and deterministic state reconstruction.

**Key capabilities:**
- `append(type, payload)` - adds an event to the immutable log
- `getState()` - replays all events to return current state
- `getStateAt(sequence)` - time-travel to any sequence number
- `getStateAtTime(timestamp)` - time-travel to a specific epoch timestamp
- `on(type, handler)` - register typed event handlers per event type
- Automatic snapshots every N events (configurable, default 50) for O(1) recovery
- `reset()` - wipe log and return to initial state

## Status
`quarantine` - isolated, not wired into any agent loop or session store yet

## Integration Path
1. Wire into `packages/memory/store.ts` as an alternative backend for episodic memory - every memory write becomes an appended event, enabling full audit trail and rollback.
2. Wire into `packages/eight/agent.ts` session loop - agent actions appended as events, enabling deterministic replay of any past session for debugging.
3. Expose via `packages/eight/tools.ts` as an agent-callable tool so Eight can introspect and replay its own session history.
4. Add persistence layer (Bun SQLite) to survive process restarts - serialize events and snapshots to a table.
