# Quarantine: fn-throttle-v2

**Status:** quarantine
**Package:** `packages/tools/fn-throttle-v2.ts`
**Size:** ~130 lines

## What it does

Improved throttle utility for rate-limiting function calls. Extends the standard leading/trailing throttle pattern with queue mode, abort support, and explicit control handles.

## API

```ts
import { throttle } from './packages/tools/fn-throttle-v2.ts';

const handle = throttle(fn, ms, options?);

handle.fn(…args)      // throttled wrapper
handle.flush()         // immediately fire any pending call
handle.cancel()        // drop all pending/queued calls
handle.pending         // count of calls waiting in queue
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `leading` | `true` | Fire on the leading edge of the window |
| `trailing` | `true` | Fire on the trailing edge of the window |
| `queue` | `false` | Buffer excess calls instead of dropping them |
| `signal` | - | AbortSignal to cancel all pending calls |

### Queue mode

When `queue: true`, excess calls during the throttle window are buffered and replayed in order after each window expires. This is useful for task dispatch where no call should be lost.

When `queue: false` (default), only the latest trailing call is kept - earlier excess calls are dropped. This is the standard debounce-like behaviour for UI events.

## Acceptance criteria

- [ ] `leading: true` - first call fires immediately
- [ ] `trailing: true` - last call in window fires after window expires
- [ ] `leading: false, trailing: true` - only trailing fires
- [ ] `queue: true` - all calls replay in order, none dropped
- [ ] `flush()` - drains pending call immediately
- [ ] `cancel()` - clears all pending without firing
- [ ] `pending` - accurate count at all times
- [ ] `signal.abort()` - silently drops all pending, no further invocations

## Promotion criteria

- Unit tests passing for all acceptance criteria above
- Benchmarked against existing `rate-limiter.ts` to confirm no performance regression
- Reviewed for use in `packages/tools/task-queue-v2.ts` dispatcher
