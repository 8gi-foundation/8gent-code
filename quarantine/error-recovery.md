# error-recovery

**Status:** quarantine
**Package:** `packages/tools/error-recovery.ts`
**Lines:** ~130

## What it does

Composable error recovery strategies for async functions. Provides five primitives - retry, fallback, ignore, log, rethrow - plus a `withRecovery` wrapper and `chainStrategies` composer.

## API

```ts
import {
  retry, fallback, ignore, log, rethrow,
  withRecovery, chainStrategies,
  RecoveryStrategy,
} from "./packages/tools/error-recovery.ts";
```

### Strategies

| Factory | Behaviour |
|---------|-----------|
| `retry(options)` | Retry the original fn up to N times with optional delay and exponential backoff |
| `fallback(fn)` | Return the result of a fallback function on error |
| `ignore()` | Swallow the error, return `undefined` |
| `log(logger?)` | Log the error then rethrow |
| `rethrow()` | Always rethrow (no-op, default) |

### Wrappers

```ts
// withRecovery - execute fn, apply strategy on failure
const result = await withRecovery(
  () => fetchData(url),
  retry({ attempts: 3, delayMs: 500, backoff: "exponential" })
);

// chainStrategies - try s1, fall through to s2 if s1 also throws
const strategy = chainStrategies(
  retry({ attempts: 2 }),
  fallback(() => cachedValue)
);
const result = await withRecovery(() => fetchData(url), strategy);
```

## Why quarantine?

Not yet wired into the agent loop or tool runner. Needs integration review:
- Should `withRecovery` wrap tool calls in `packages/eight/tools.ts`?
- Should `retry` options be configurable per-tool via policy engine?
- Logging should route through the structured logger, not `console.error`.

## Integration checklist

- [ ] Wire into `packages/eight/tools.ts` tool executor
- [ ] Expose retry config in `packages/permissions/policy-engine.ts`
- [ ] Replace ad-hoc retry logic in `packages/daemon/` and `packages/kernel/`
- [ ] Replace `console.error` logger with structured logger from `packages/tools/color-logger.ts`
- [ ] Add tests
