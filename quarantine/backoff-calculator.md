# backoff-calculator

**Status:** quarantine

## Description

Calculates retry backoff delays with configurable curves and jitter strategies. Useful for any retry logic that needs production-grade delay calculation without external dependencies.

## API

- `exponentialBackoff(attempt, options)` - returns a single delay for exponential curve
- `linearBackoff(attempt, options)` - returns a single delay for linear curve
- `BackoffIterator` - stateful iterator that yields successive delays per retry

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `base` | 100ms | Base delay |
| `max` | 30000ms | Cap on delay |
| `multiplier` | 2 | Growth factor (exponential only) |
| `jitter` | `"full"` | `none`, `full`, `equal`, `decorrelated` |
| `maxRetries` | 0 (unlimited) | Stop iterating after N retries |

## Jitter Strategies

- **none** - deterministic, same delay every time
- **full** - uniform random in [0, raw] - AWS recommended for high concurrency
- **equal** - half deterministic + half random - balances spread and minimum delay
- **decorrelated** - each delay derived from the previous - avoids thundering herd

## Integration Path

This tool is self-contained with no dependencies. Integration options:

1. Import directly in `packages/eight/agent.ts` retry loop
2. Wire into `packages/validation/` checkpoint-verify-revert loop for retry on failure
3. Expose as an agent tool in `packages/eight/tools.ts` so Eight can calculate delays dynamically
4. Use in `packages/daemon/` reconnect logic for WebSocket retry

## Usage Example

```typescript
import { BackoffIterator, exponentialBackoff } from "./packages/tools/backoff-calculator";

// Single delay
const { delay } = exponentialBackoff(3, { base: 200, jitter: "full" });
await sleep(delay);

// Iterator-based retry loop
const backoff = new BackoffIterator("exponential", { base: 100, max: 10_000, maxRetries: 5 });
for (const { delay, attempt, exhausted } of backoff) {
  const ok = await tryOperation();
  if (ok) break;
  await sleep(delay);
}
```
