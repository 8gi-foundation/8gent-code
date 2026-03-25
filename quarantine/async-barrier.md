# quarantine: async-barrier

**Status:** quarantine - review before wiring into agent loop

## What it does

Two synchronization primitives for coordinating multiple concurrent async tasks:

- `Barrier` - N parties must all arrive before any can proceed (cyclic, auto-resets each generation)
- `CountdownLatch` - N events must fire before waiting callers are unblocked (single-use by default, call `reset()` to rearm)

## API

```ts
import { Barrier, CountdownLatch } from "../packages/tools/async-barrier.ts";

// Barrier - all 3 workers rendezvous before continuing
const barrier = new Barrier(3);

async function worker(id: number) {
  console.log(id + " before barrier");
  await barrier.arrive(); // blocks until all 3 have called arrive()
  console.log(id + " after barrier");
}

await Promise.all([worker(0), worker(1), worker(2)]);

// CountdownLatch - wait for N events before proceeding
const latch = new CountdownLatch(3);

startWorkers(() => latch.countDown()); // each worker calls countDown() when done
await latch.wait();                    // blocks until count reaches 0
console.log("all workers done");

// Reset for reuse
latch.reset();     // rearms with original count
latch.reset(5);    // rearms with new count
```

## Features

- `Barrier(count)` - cyclic barrier, auto-resets after every generation
- `barrier.arrive()` - returns Promise resolved when all parties have arrived
- `barrier.reset()` - abort current generation, discard waiting callers, clear state
- `barrier.pendingCount` - number of parties still waiting
- `CountdownLatch(count)` - single-use countdown from N to 0
- `latch.countDown()` - decrement; releases waiters when count hits 0
- `latch.wait()` - returns Promise resolved when count reaches 0 (immediate if already 0)
- `latch.reset(n?)` - rearm with new or original count
- `latch.remaining` - current count

## Constraints

- `Barrier` is cyclic - the Nth arrival releases everyone and resets automatically
- `CountdownLatch` is NOT cyclic by default - call `reset()` explicitly to reuse
- Both constructors throw `RangeError` if count < 1
- `barrier.reset()` silently discards waiting callers without resolving them - only use when aborting
- `latch.countDown()` is a no-op once count reaches 0

## Files

- `packages/tools/async-barrier.ts` - implementation (~140 lines)

## Not doing

- No timeout support (compose externally with `Promise.race`)
- No rejection/error propagation (barrier is a coordination primitive, not an error channel)
- No thread-safety guarantees beyond single-threaded JS event loop
