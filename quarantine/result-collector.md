# quarantine: result-collector

**Status:** quarantine - review before wiring into agent loop

## What it does

`ResultCollector<T>` collects success and failure results from multiple operations,
providing rate calculation, structured summaries, and JSON serialisation.

## API

```ts
import { ResultCollector } from "../packages/tools/result-collector.ts";

const collector = new ResultCollector<string>();

collector.addSuccess("file written");
collector.addSuccess("cache cleared");
collector.addFailure(new Error("network timeout"));

console.log(collector.hasFailures());   // true
console.log(collector.successRate());   // 0.666...
console.log(collector.summary());       // "2/3 succeeded (66.7%) - 1 failure"
console.log(collector.toJSON());
// { total: 3, successCount: 2, failureCount: 1, successRate: 0.666, failures: ["network timeout"] }
```

## Features

- `add(result)` - insert a pre-built `CollectedResult` (ok/fail union)
- `addSuccess(value)` - record a successful result with its value
- `addFailure(error)` - record a failed result with Error or string message
- `successes()` - array of all `SuccessResult<T>` entries
- `failures()` - array of all `FailureResult` entries
- `hasFailures()` - boolean guard, useful in if-blocks and assertions
- `successRate()` - 0-1 ratio; returns 0 when empty
- `summary()` - human-readable one-liner for logs and TUI output
- `toJSON()` - serialisable `CollectorSummary` snapshot
- `clear()` - reset for reuse across phases

## Constraints

- Not a promise wrapper - caller resolves promises and calls add/addSuccess/addFailure
- No deduplication - each call appends a new entry
- Timestamps recorded per-entry but not exposed in summary (available via successes()/failures())

## Files

- `packages/tools/result-collector.ts` - implementation (~110 lines)

## Not doing

- No async wrapping (keep it synchronous and composable)
- No retry logic (use batch-processor or external wrappers)
- No streaming or live observers
