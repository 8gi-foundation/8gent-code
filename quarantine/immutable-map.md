# Quarantine: immutable-map

## Tool name

`ImmutableMap`

## Description

Persistent immutable map with structural sharing. Every write operation
(`set`, `delete`, `merge`) returns a new `ImmutableMap` instance leaving the
original intact. Internally backed by a frozen plain object, so unchanged keys
are shared between versions at zero cost.

Supported operations:

- `set(key, value)` - returns new map with key set
- `delete(key)` - returns new map with key removed
- `get(key)` - reads a value
- `has(key)` - membership test
- `entries()` / `keys()` / `values()` - iterators
- `merge(other)` - shallow merge, other wins on conflict
- `toObject()` - plain object snapshot

Static factories: `ImmutableMap.empty()`, `ImmutableMap.from(entries)`,
`ImmutableMap.fromObject(obj)`.

## Status

**quarantine** - validated API, no integration yet.

## Integration path

1. Import from `packages/tools/immutable-map.ts` into any package that needs
   safe state snapshots (e.g. `packages/memory/`, `packages/self-autonomy/`).
2. Replace any `Object.assign` / spread-mutate patterns with `ImmutableMap` to
   make state history trackable and rollbacks trivial.
3. Consider wiring into `packages/validation/` checkpoint snapshots as an
   alternative to `git stash` for in-process state.
