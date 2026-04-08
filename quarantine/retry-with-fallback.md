# Quarantine: retry-with-fallback

**Status:** quarantine - not yet wired into core
**Package:** `packages/tools/retry-with-fallback.ts`
**Branch:** `quarantine/retry-with-fallback`

---

## What it does

Provides two exports for running an operation with retries and ordered fallbacks:

- `withFallback(primary, fallbacks[], options)` - functional API
- `FallbackChain` - builder pattern for readable chaining

Flow:
1. Attempt `primary` up to `retries` times with exponential backoff.
2. If primary exhausts all attempts, move to `fallbacks[0]` - same retry budget.
3. Continue through each fallback in order until one succeeds.
4. If every level fails, throw `AggregateError` with all collected errors.

Returns `FallbackResult<T>` with the value, which `level` succeeded (0 = primary), and total attempt count.

---

## Usage

### Functional

```ts
import { withFallback } from "./packages/tools/retry-with-fallback";

const result = await withFallback(
  () => fetchFromPrimary(),
  [() => fetchFromReplica(), () => fetchFromCache()],
  { retries: 3, baseDelayMs: 200 }
);

console.log(`Succeeded at level ${result.level} after ${result.totalAttempts} attempts`);
```

### Builder

```ts
import { FallbackChain } from "./packages/tools/retry-with-fallback";

const result = await new FallbackChain(() => callPrimaryModel())
  .fallback(() => callFallbackModel())
  .fallback(() => returnCachedResponse())
  .options({ retries: 2, baseDelayMs: 100, onRetry: (err, attempt) => console.warn(attempt, err) })
  .run();
```

---

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `retries` | 3 | Max attempts per level |
| `baseDelayMs` | 200 | Base backoff delay in ms |
| `maxDelayMs` | 5000 | Delay cap in ms |
| `onRetry` | undefined | Called on each failed attempt: `(error, attempt, level)` |

Backoff formula: `min(base * 2^attempt + jitter, maxDelayMs)`

---

## Intended integration points

- `packages/eight/agent.ts` - LLM call retry with model fallback
- `packages/memory/store.ts` - SQLite write with fallback to in-memory
- `packages/providers/` - primary model falls back to free tier model

---

## Why quarantine?

No existing code imports this yet. Placing it here to allow review before wiring into the agent loop or provider stack. Integration needs a decision on which call sites should adopt this vs the existing ad-hoc retry logic in `agent.ts`.

---

## Constraints

- No external deps - stdlib only
- 130 lines
- Backoff is exponential with jitter, capped at `maxDelayMs`
- `AggregateError` preserves all per-level errors for debugging
