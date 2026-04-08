# Quarantine: stack-data-structure

**Status:** quarantine
**File:** `packages/tools/stack-data-structure.ts`

## What it is

Generic `Stack<T>` class with configurable max capacity. LIFO semantics. Throws on overflow/underflow. No dependencies.

## API

| Method | Signature | Notes |
|--------|-----------|-------|
| `push` | `push(item: T): this` | Chainable. Throws if full. |
| `pop` | `pop(): T` | Throws if empty. |
| `peek` | `peek(): T` | Throws if empty. |
| `peekOrUndefined` | `peekOrUndefined(): T \| undefined` | Safe peek. |
| `contains` | `contains(item: T): boolean` | Strict equality scan. |
| `isEmpty` | `isEmpty(): boolean` | |
| `isFull` | `isFull(): boolean` | |
| `size` | `get size(): number` | |
| `capacity` | `get capacity(): number` | |
| `clear` | `clear(): void` | |
| `toArray` | `toArray(): T[]` | Bottom-to-top array copy. |
| `[Symbol.iterator]` | Iterable<T> | Top-to-bottom (LIFO). |

## Usage

```ts
import { Stack } from "./packages/tools/stack-data-structure";

// Unbounded
const s = new Stack<number>();
s.push(1).push(2).push(3);
s.peek();    // 3
s.pop();     // 3
s.size;      // 2

// Bounded
const bounded = new Stack<string>(5);
bounded.isFull();       // false
bounded.push("a");
bounded.contains("a");  // true

// Iterate top-to-bottom
for (const item of bounded) {
  console.log(item);
}
```

## Why quarantine

New utility - needs review to confirm it doesn't duplicate existing queue/state-history patterns before merging to main tool index.

## Promotion checklist

- [ ] No overlap with `queue-with-priority.ts` or `state-history.ts`
- [ ] Unit tests added under `packages/tools/__tests__/`
- [ ] Exported from `packages/tools/index.ts`
- [ ] Used by at least one consumer
