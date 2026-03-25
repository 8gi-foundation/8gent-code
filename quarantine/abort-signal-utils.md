# abort-signal-utils

**Status:** Quarantine
**Location:** `packages/tools/abort-signal-utils.ts`
**Size:** ~130 lines

## What it does

Composable utilities for working with `AbortSignal` and `AbortController` in async cancellation patterns. Covers the common gaps the native API leaves open.

## API

| Export | Signature | Description |
|--------|-----------|-------------|
| `mergeSignals` | `(...signals: AbortSignal[]) => AbortSignal` | Returns a signal that aborts when any input aborts |
| `timeoutSignal` | `(ms: number) => AbortSignal` | Signal that auto-aborts after `ms` milliseconds |
| `raceSignals` | `(...signals: AbortSignal[]) => AbortSignal` | Alias for `mergeSignals` with clearer intent |
| `onAbort` | `(signal, fn) => () => void` | Register a callback on abort; returns cleanup fn |
| `throwIfAborted` | `(signal: AbortSignal) => void` | Throw `AbortError` at async checkpoints |
| `isAborted` | `(signal: AbortSignal) => boolean` | Simple predicate check |
| `abortablePromise` | `<T>(promise, signal) => Promise<T>` | Wrap any promise so it rejects on abort |

## Usage

```ts
import {
  mergeSignals,
  timeoutSignal,
  abortablePromise,
  throwIfAborted,
} from "./packages/tools/abort-signal-utils";

// Combine a user-cancel signal with a 30s timeout
const userController = new AbortController();
const combined = mergeSignals(userController.signal, timeoutSignal(30_000));

// Wrap any fetch or async op
const result = await abortablePromise(fetch("/api/data", { signal: combined }), combined);

// Checkpoint inside a loop
for (const item of bigList) {
  throwIfAborted(combined);
  await processItem(item);
}
```

## Why quarantine

No tests yet. Needs integration with the agent loop's existing cancellation paths (ESC -> `agent.abort()`) before promotion. The `onAbort` listener cleanup pattern also needs verification under high-churn signal creation.

## Promotion criteria

- [ ] Unit tests covering all 7 exports
- [ ] Wire `mergeSignals` into `packages/eight/agent.ts` abort path
- [ ] Verify no listener leaks under 1000+ rapid abort cycles
- [ ] Replace any inline `signal.aborted` checks in `packages/tools/` with `throwIfAborted`
