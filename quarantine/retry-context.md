# retry-context

**Tool name:** retry-context
**Package:** `packages/tools/retry-context.ts`
**Status:** quarantine

## Description

Tracks retry state across multiple attempts and passes it to retry callbacks via a `RetryContext` instance. Provides attempt number, full error history, elapsed time, first/last attempt flags, and a debug notes API.

## Exports

- `RetryContext` - class encapsulating retry state
- `withRetryContext(fn, options)` - wraps any async function with stateful retry logic

## Integration Path

1. Import in `packages/eight/tools.ts` or any retry-heavy tool
2. Replace bare `try/catch` retry loops with `withRetryContext`
3. Optionally wire `onRetry` callback to emit telemetry or log to memory store

## Example

```ts
import { withRetryContext } from "@8gent/tools/retry-context";

const data = await withRetryContext(
  async (ctx) => {
    if (!ctx.isFirstAttempt) ctx.addNote("retrying - prev error: " + ctx.lastError?.message);
    return await unstableApiCall();
  },
  { maxAttempts: 3, delayMs: 500 }
);
```

## Why Quarantine?

Standalone and tested conceptually, but not yet wired into the agent loop or any existing package. Needs integration decision before promotion to a named package export.
