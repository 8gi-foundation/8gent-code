# Quarantine: sandboxed-timer

**Status:** quarantined - awaiting review before wiring into any agent loop

## What it is

`packages/tools/sandboxed-timer.ts` - a `TimerScope` class that registers
`setTimeout`/`setInterval` handles and guarantees they are all cancelled when
`dispose()` is called (or the `using` block exits in TS 5.2+).

## Problem it solves

Agent sessions and tool calls create timers (polling, heartbeats, debounce) and
don't always clean them up on abort or scope exit. Leaked timers accumulate
across sessions, cause phantom callbacks, and eventually crash the process.

## API surface

```ts
const scope = new TimerScope();

scope.timeout(() => doWork(), 500, "my-task");
const cancel = scope.interval(() => poll(), 1000, "poll");

scope.size;            // pending count
scope.pendingLabels;   // ["my-task", "poll"]

cancel();              // cancel one
scope.dispose();       // cancel all - idempotent
```

TS 5.2+ explicit resource management:
```ts
{
  using scope = new TimerScope();
  scope.interval(() => heartbeat(), 5000, "hb");
} // auto-disposed here
```

Convenience wrapper:
```ts
await withTimerScope(async (scope) => {
  scope.interval(() => ping(), 2000, "ping");
  await doLongWork();
}); // all timers cancelled
```

## Constraints

- No external dependencies - pure Node/Bun timer APIs only
- 120 lines, zero blast radius
- Not wired into any agent loop yet - safe to review in isolation

## Integration path (post-review)

1. Import `TimerScope` in `packages/eight/agent.ts`
2. Create one scope per session, pass down to tools that need timers
3. Call `scope.dispose()` inside the existing `abort()` cleanup path

## What this is NOT doing

- Not replacing the existing rate-limiter or rolling-average timers
- Not modifying any existing file
- Not wiring into production agent loops until review passes
