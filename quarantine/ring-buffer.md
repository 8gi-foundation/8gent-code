# ring-buffer

## Tool name
RingBuffer<T>

## Description
Fixed-capacity circular buffer that overwrites the oldest entry when full.
Useful for bounded event/log storage in agent loops where you only care about
the N most-recent entries. Ships as a zero-dependency TypeScript generic class.

Key characteristics:
- O(1) push and peek
- O(n) drain, iteration, and toArray
- Overwrites oldest entry on overflow, returns evicted item to caller
- Full iterator protocol (for...of support)
- peek() / peekLast() for non-destructive inspection
- drain() to atomically empty the buffer into an array
- shift() for FIFO consumption

## Status
quarantine

## Integration path
1. Export from packages/tools/index.ts:
   export { RingBuffer } from "./ring-buffer.js";
2. In packages/eight/agent.ts - replace unbounded recentEvents string[] with
   new RingBuffer<string>(200) to cap memory during long sessions.
3. In packages/memory/store.ts - use as write queue, flush in batches,
   dropping stale entries if the agent is busy.

## Files
- packages/tools/ring-buffer.ts - implementation (~90 lines)
