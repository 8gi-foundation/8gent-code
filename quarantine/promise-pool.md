# promise-pool

**Status:** quarantine

## Description

Runs async operations with configurable concurrency limits, queue management,
progress tracking, and error collection. Built for parallel agent tasks where
you need to process N items but cap simultaneous inflight operations.

## Exports

- `PromisePool` - class-based API with `map()` and `forEach()` over item arrays
- `mapPool(items, fn, concurrency)` - functional helper, throws on first error
- `mapPoolSafe(items, fn, concurrency)` - functional helper, collects all errors

## Usage

```ts
import { mapPool, PromisePool } from "../packages/tools/promise-pool";

// Simple: fetch 50 URLs with max 5 concurrent
const pages = await mapPool(urls, (url) => fetch(url).then(r => r.text()), 5);

// With progress tracking
const pool = new PromisePool({
  concurrency: 10,
  onProgress: (done, total) => console.log(`${done}/${total}`),
  continueOnError: true,
});
const { values, errors } = await pool.map(items, processItem);
```

## Integration Path

- `packages/orchestration/` - use as the concurrency layer inside `WorktreePool`
  task dispatch instead of ad-hoc `Promise.allSettled` slices
- `packages/eight/agent.ts` - parallel tool calls during multi-step plans
- `packages/proactive/` - bounded parallelism for GitHub bounty scanner and
  opportunity pipeline fetches
- Any existing code that does `Promise.all(items.map(fn))` with no cap

## Notes

- No external dependencies. Self-contained TypeScript.
- Preserves original item order in returned values array.
- Queue overflow is handled automatically - workers pull from the queue as
  capacity frees up; no batching needed at the call site.
