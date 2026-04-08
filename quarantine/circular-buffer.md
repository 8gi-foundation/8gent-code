# Quarantine: circular-buffer

**Status:** quarantine - under review
**File:** `packages/tools/circular-buffer.ts`
**Added:** 2026-03-25

## What it does

Typed generic circular buffer (ring buffer) backed by a fixed-size array.

- `push(item)` - add an item; overflow behaviour is configurable
- `shift()` - remove and return the oldest item (FIFO)
- `peek()` - read oldest without removing
- `isFull()` / `isEmpty()` - state guards
- `toArray()` - snapshot in insertion order (oldest first)
- `clear()` - reset buffer
- `.capacity` / `.size` - read-only accessors
- `[Symbol.iterator]` - for-of support, oldest to newest

## Overflow strategies

| Strategy | Behaviour |
|----------|-----------|
| `"overwrite"` (default) | oldest entry is silently dropped to make room |
| `"throw"` | `RangeError` thrown when buffer is full |

## Usage

```ts
import { CircularBuffer } from "./packages/tools/circular-buffer";

// Rolling log - keep last 5 entries, overwrite oldest
const log = new CircularBuffer<string>(5);
log.push("a");
log.push("b");
log.toArray(); // ["a", "b"]

// Strict queue - throw on overflow
const strict = new CircularBuffer<number>(3, { overflow: "throw" });
strict.push(1);
strict.push(2);
strict.push(3);
strict.push(4); // throws RangeError

// Iteration
for (const entry of log) {
  console.log(entry);
}
```

## Why quarantine?

New utility with no existing callers. Needs review before wiring into agent
tools index or consuming packages.

## Promotion criteria

- [ ] At least one internal consumer identified (e.g. rolling metrics, event
  timeline, audio queue)
- [ ] Edge cases verified: capacity 1, concurrent push+shift cycle, iterator
  during mutation
- [ ] Exported from `packages/tools/index.ts`
