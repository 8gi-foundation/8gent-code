# quarantine: wrap-fn

**Status:** Quarantined - review before wiring into core
**File:** `packages/tools/wrap-fn.ts`
**Lines:** ~140

## What it does

Function wrapper utilities for cross-cutting concerns. Six composable decorators that can be layered onto any function without modifying its source.

| Export | Purpose |
|--------|---------|
| `before(fn, beforeFn)` | Run side-effect before fn executes |
| `after(fn, afterFn)` | Run side-effect after fn returns (async-aware) |
| `around(fn, wrapper)` | Full control - wrapper decides when/if to call original |
| `guard(fn, predicate, fallback)` | Short-circuit fn if predicate fails |
| `profile(fn)` | Returns `{ result, durationMs }` per call |
| `log(fn, options)` | Logs args + return value via configurable logger |

## Usage examples

```ts
import { before, after, around, guard, profile, log } from "./packages/tools/wrap-fn.ts";

// Log every call to a tool executor
const tracedExec = log(execTool, { label: "execTool" });

// Guard a destructive action behind a permissions check
const safeDelete = guard(deleteFile, (path) => hasPermission("write", path), false);

// Measure how long a search takes
const timed = profile(searchMemory);
const { result, durationMs } = await timed("query text");
console.log(`Search took ${durationMs.toFixed(1)}ms`);

// Invalidate a cache entry after a write
const trackedWrite = after(writeRecord, (result, id) => invalidateCache(id));

// Composable - stack wrappers
const instrumented = log(profile(guard(expensiveFn, () => featureEnabled("x"))));
```

## Design notes

- All wrappers preserve `this` binding via `.apply(this, args)`.
- `after` and `log` handle `Promise` returns transparently - they chain `.then()` rather than awaiting, so they work in sync contexts too.
- `profile` changes the return type - use it at the call site, not in production paths where callers expect the raw return value.
- `guard` fallback can be a static value or a function - useful when the fallback itself needs to compute based on args.

## Potential wiring points

- Agent tool executor - log + guard every tool call
- Memory store writes - profile slow operations
- Permission gates - guard behind policy checks
- Benchmark harness - profile target functions automatically

## Quarantine exit criteria

- [ ] At least one real usage in a package (not just tests)
- [ ] TypeScript strict mode passes with no `any` errors at call sites
- [ ] Async edge cases verified (rejected promises propagate correctly)
- [ ] Re-export added to `packages/tools/index.ts`
