# quarantine: retry-circuit

**Status:** quarantine - review before wiring into agent loop

## What it does

`resilient(fn, options)` wraps any async function with both retry logic and a
circuit breaker in a single call. Retries transient failures with exponential
backoff. Opens the circuit after consecutive failures to fail fast and avoid
hammering degraded downstream services.

## API

```ts
import { resilient } from "../packages/tools/retry-circuit.ts";

const call = resilient(() => callExternalAPI(), {
  maxRetries: 3,
  backoff: 300,
  circuitThreshold: 5,
  circuitTimeout: 15_000,
  onRetry: (err, attempt) => console.error(`attempt ${attempt} failed`, err),
  onStateChange: (from, to) => console.log(`circuit: ${from} -> ${to}`),
});

const data = await call();
console.log(call.stats());
// { state: "CLOSED", successCount: 1, failureCount: 0, rejectedCount: 0, ... }

call.reset(); // reset all counters and close the circuit
```

## Circuit states

| State | Behaviour |
|-------|-----------|
| CLOSED | Normal - all calls pass through with retry |
| OPEN | Tripped - calls rejected immediately (CircuitOpenError) |
| HALF_OPEN | Probe - one call allowed to test recovery |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxRetries` | 3 | Attempts per call before giving up |
| `backoff` | 200ms | Base delay for exponential backoff |
| `maxBackoff` | 5000ms | Backoff delay cap |
| `circuitThreshold` | 5 | Consecutive failures to open circuit |
| `circuitTimeout` | 30000ms | Time before probing recovery |
| `onRetry` | - | Hook called on each failed attempt |
| `onStateChange` | - | Hook called on circuit state transitions |

## Stats shape

```ts
{
  state: "CLOSED" | "OPEN" | "HALF_OPEN";
  successCount: number;
  failureCount: number;
  rejectedCount: number;
  consecutiveFailures: number;
  openedAt: number | null;
}
```

## Features

- Exponential backoff with jitter between retries
- Circuit opens after `circuitThreshold` consecutive failures
- HALF_OPEN probe: one request through after `circuitTimeout` ms
- `stats()` returns a snapshot - safe to poll without side effects
- `reset()` for testing or manual recovery

## Constraints

- One instance wraps one function - not a global singleton
- Circuit threshold counts consecutive failures, not total
- `CircuitOpenError` is thrown synchronously when circuit is OPEN

## Files

- `packages/tools/retry-circuit.ts` - implementation (~140 lines)

## Not doing

- No per-error-type filtering (all errors count toward threshold)
- No distributed state - circuit state is in-process only
- No automatic metrics export - hook `onStateChange` and `onRetry` for that
