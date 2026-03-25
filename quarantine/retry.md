# retry.ts - Exponential Backoff Retry Utility

**Location:** `packages/tools/retry.ts`
**Status:** Quarantine - needs integration tests and wiring into tool index.

## Problem

Provider calls, browser fetches, and external API requests fail transiently. Every call site was rolling its own retry loop with inconsistent backoff logic.

## What it does

Single `retry(fn, opts)` function with exponential backoff, jitter, abort conditions, and cancellation via AbortSignal.

## API

```ts
import { retry } from "@8gent/tools/retry";

const result = await retry(() => fetchFromProvider(prompt), {
  maxAttempts: 4,
  baseDelay: 1000,
  maxDelay: 15_000,
  backoffFactor: 2,
  jitter: 0.25,
  shouldAbort: (err) => err instanceof AuthError,
  onRetry: (err, attempt, delay) => console.log(`Retry ${attempt}, waiting ${delay}ms`),
  signal: controller.signal,
});
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxAttempts` | 3 | Total attempts including the first call |
| `baseDelay` | 500ms | Delay before first retry |
| `maxDelay` | 30s | Delay cap |
| `backoffFactor` | 2 | Multiplier per attempt |
| `jitter` | 0.25 | Random jitter fraction (0-1) added to delay |
| `shouldAbort` | - | Return true to stop retrying (e.g. auth errors) |
| `onRetry` | - | Callback before each retry wait |
| `signal` | - | AbortSignal to cancel during wait |

### Error types

- `RetriesExhaustedError` - all attempts failed, `.lastError` has the final error
- `RetryAbortedError` - `shouldAbort` returned true, `.lastError` + `.attempt`

## Exit criteria

- [ ] Unit tests covering: success on 1st try, success on Nth try, exhaustion, abort, signal cancellation
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Replace ad-hoc retry loops in provider calls with this utility
