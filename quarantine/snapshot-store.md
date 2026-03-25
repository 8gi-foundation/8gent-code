# snapshot-store

Stores and compares state snapshots over time for debugging, rollback, and diff-based auditing.

## What it does

`SnapshotStore<T>` maintains an ordered list of timestamped state snapshots. Supports capture, retrieval, rollback, structural diff, and pruning.

## API

```ts
import { SnapshotStore } from '../packages/tools/snapshot-store';

const store = new SnapshotStore<MyState>();

const s1 = store.take(stateA, 'before migration');
const s2 = store.take(stateB, 'after migration');

store.latest();               // most recent snapshot
store.list();                 // all snapshots, oldest first
store.get(s1.id);             // look up by id

store.compare(s1.id, s2.id); // { added, removed, changed }
store.diff(s1, s2);           // same, from snapshot objects directly

store.rollback(s1.id);        // returns s1.state, drops s2 and any after
store.prune(10);              // keep only last 10 snapshots
store.clear();                // wipe everything
store.size();                 // number of stored snapshots
```

## DiffResult shape

```ts
{
  added: string[];          // keys present in B but not A (dot-notation)
  removed: string[];        // keys present in A but not B
  changed: Array<{
    key: string;
    from: unknown;
    to: unknown;
  }>;
}
```

Nested objects are flattened to dot-notation paths (`user.profile.name`) before comparison.

## Options

None - the store is instantiated with no config. Use `prune(n)` to cap memory usage at call sites.

## Use cases

- Agent session state auditing between tool calls
- Before/after diffs when applying config mutations
- Rollback to a known-good checkpoint after a failed operation
- Debugging state drift in long-running daemon processes

## Status

Quarantine - standalone, no deps, ready to wire into any consumer.
