# Quarantine: promise-timeout

## What

Async flow control utilities for promises: hard timeout, exponential-backoff retry, delay, race with a fulfillment count, bounded-concurrency all, and bounded-concurrency map. Zero dependencies, pure TypeScript.

## File

`packages/tools/promise-timeout.ts` (~140 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import {
  pTimeout, pRetry, pDelay, pRace, pAll, pMap,
  TimeoutError, RetryError
} from './packages/tools/promise-timeout.ts';

// pTimeout - reject with TimeoutError if promise takes too long
await pTimeout(fetch('/api/data'), 3000);
await pTimeout(heavyTask(), 10_000, 'heavy task timed out');

// pRetry - exponential backoff, configurable attempts
const data = await pRetry(
  (attempt) => fetch(`/api/data?attempt=${attempt}`).then(r => r.json()),
  { attempts: 5, delay: 300, factor: 2, maxDelay: 5000 }
);

// pDelay - resolve after N ms
await pDelay(500);
const val = await pDelay(200, 'hello'); // resolves to 'hello'

// pRace - resolve once N of the promises fulfill (default 1)
const [first] = await pRace([p1, p2, p3]);           // fastest
const [a, b]  = await pRace([p1, p2, p3], 2);        // first 2 winners

// pAll - all promises with bounded concurrency
const results = await pAll([p1, p2, p3, p4], 2);     // max 2 in-flight

// pMap - map over items with bounded concurrency, preserves order
const pages = await pMap(urls, (url) => fetch(url).then(r => r.text()), { concurrency: 3 });
```

## Error Types

| Class | When |
|-------|------|
| `TimeoutError` | `pTimeout` deadline exceeded; `.ms` = configured timeout |
| `RetryError` | `pRetry` exhausted all attempts; `.attempts`, `.cause` |

## Reason for Quarantine

- No integration tests yet
- Not exported from `packages/tools/index.ts`
- Awaiting review before wiring into agent tool registry
