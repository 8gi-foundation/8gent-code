# Quarantine: hash-set

**Status:** Under review - not yet integrated into main agent toolchain.

## What it is

`HashSet<T>` - a Set built on a custom hash function for object equality. Solves the problem of JS `Set` using reference equality for objects, making it useless for value-based deduplication.

## Location

`packages/tools/hash-set.ts`

## API

```ts
import { HashSet } from './packages/tools/hash-set.ts';

const set = new HashSet<{ id: number }>(item => item.id);

set.add({ id: 1 });      // true
set.add({ id: 1 });      // false - duplicate by hash
set.has({ id: 1 });      // true
set.size;                 // 1
set.delete({ id: 1 });   // true
set.toArray();            // []
```

## Set operations

All operations return a new `HashSet` using the same hash function from the left-hand operand.

```ts
const a = new HashSet<number>(x => x, [1, 2, 3]);
const b = new HashSet<number>(x => x, [2, 3, 4]);

a.intersection(b).toArray();  // [2, 3]
a.union(b).toArray();         // [1, 2, 3, 4]
a.difference(b).toArray();    // [1]
a.isSubsetOf(b);              // false
```

## Why quarantine?

- No tests yet. Needs unit coverage before wiring into agent tools.
- Hash collision behavior is caller's responsibility - document the contract better.
- Consider adding `forEach`, `entries`, and `values` for full `Set`-interface parity if promoted.

## Integration path

If promoted: export from `packages/tools/index.ts`, add to agent tool registry, write test file at `packages/tools/__tests__/hash-set.test.ts`.
