# Circuit Breaker

**File:** `packages/tools/circuit-breaker.ts`
**Export:** `CircuitBreaker` class
**Status:** Quarantine - pending integration review

---

## What it does

Wraps any async function call with a circuit breaker. Prevents cascading failures by fast-failing when a downstream service is unhealthy, then probing recovery automatically.

## States

| State | Behaviour |
|-------|-----------|
| `CLOSED` | Normal. All calls pass through. Failure count tracked. |
| `OPEN` | Tripped. Calls fail fast (or hit fallback) until timeout expires. |
| `HALF_OPEN` | Probe state. Limited calls allowed. Successes close; failures re-open. |

## Usage

```ts
import { CircuitBreaker } from "../packages/tools/circuit-breaker";

const breaker = new CircuitBreaker({
  failureThreshold: 5,       // open after 5 consecutive failures
  successThreshold: 2,       // close after 2 consecutive successes in HALF_OPEN
  timeout: 30_000,           // ms before transitioning OPEN -> HALF_OPEN
  halfOpenMaxRequests: 1,    // max concurrent probes in HALF_OPEN
  fallback: () => null,      // optional: return instead of throwing
  onStateChange: (from, to) => console.log(`Circuit: ${from} -> ${to}`),
});

const result = await breaker.execute(fetchUserProfile, userId);
```

## API

### `execute<T>(fn, ...args): Promise<T>`
Runs `fn(...args)` through the circuit. Throws `CircuitBreakerError` when OPEN (or invokes fallback).

### `getState(): CircuitState`
Returns current state, triggering OPEN -> HALF_OPEN transition if timeout has elapsed.

### `getStats(): CircuitBreakerStats`
Returns snapshot: state, failure count, success count, total calls, last failure time, last state change time.

### `reset()`
Forces circuit to CLOSED and clears all counters.

### `forceOpen()`
Manually opens the circuit (useful for maintenance windows).

## Zero dependencies

No imports beyond TypeScript types. Works with Bun, Node, or any JS runtime.

## Integration candidates

- `packages/eight/agent.ts` - wrap LLM provider calls
- `packages/providers/` - per-provider breaker instances
- `packages/daemon/` - protect WebSocket reconnection loops
- `packages/memory/store.ts` - protect SQLite writes under load
