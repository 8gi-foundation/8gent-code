# Quarantine: lazy-sequence

**Status:** Quarantined - pending review
**File:** `packages/tools/lazy-sequence.ts`
**Size:** ~150 lines
**Dependencies:** none (pure TypeScript)

## What it does

A lazy evaluation sequence utility that wraps any `Iterable<T>` and chains
operations without executing them until a terminal call is made.

## API

```ts
import { Seq } from './packages/tools/lazy-sequence';

// Intermediate (lazy) operations - return a new Seq, nothing runs yet
Seq.from(iterable)
  .map(fn)        // transform each element
  .filter(fn)     // keep elements passing predicate
  .take(n)        // stop after n elements
  .skip(n)        // skip first n elements
  .flatMap(fn)    // map + flatten one level
  .distinct()     // deduplicate via Set

// Terminal operations - materialize the sequence
  .toArray()      // T[]
  .reduce(fn, init)
  .forEach(fn)
  .first()        // T | undefined
  .count()        // number
```

## Example

```ts
const result = Seq.from([1, 2, 2, 3, 4, 5, 5, 6])
  .distinct()
  .filter(x => x % 2 === 0)
  .map(x => x * 10)
  .take(3)
  .toArray();
// [20, 40, 60]
```

## Why quarantine

- Not yet wired into the agent tool registry
- No benchmark coverage
- `distinct()` uses a `Set` - unsuitable for non-primitive reference types without a custom key fn
- Worth extending with `distinctBy(keyFn)` before production use

## Promotion checklist

- [ ] Add `distinctBy(keyFn)` variant
- [ ] Add `zip(other)` for parallel iteration
- [ ] Write benchmark comparing against native array chaining on 100k items
- [ ] Wire into `packages/eight/tools.ts` if agent tooling needs lazy iteration
