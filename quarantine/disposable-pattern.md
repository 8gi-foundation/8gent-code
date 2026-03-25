# disposable-pattern

## Tool Name
`disposable-pattern`

## Description
Implements the Disposable pattern for deterministic resource cleanup in TypeScript.
Provides a `Disposable` interface, `using()` and `usingAsync()` helpers that guarantee
dispose on exit, and a `DisposableStack` that manages multiple resources with LIFO
teardown and AggregateError reporting.

Useful anywhere a resource (file handle, DB connection, lock, timer, stream) must be
released regardless of success or failure - without try/finally boilerplate scattered
across callsites.

## Status
`quarantine`

Implemented, not yet wired into any package. Needs a real callsite before promotion.

## Exports
| Export | Type | Purpose |
|---|---|---|
| `Disposable` | interface | Sync or async `dispose()` contract |
| `using(resource, fn)` | function | Sync auto-cleanup helper |
| `usingAsync(resource, fn)` | function | Async auto-cleanup helper |
| `DisposableStack` | class | Multi-resource LIFO cleanup with `add()` and `defer()` |

## Integration Path
1. Pick a package that opens external resources (e.g. `packages/memory/`, `packages/tools/browser/`).
2. Import from `packages/tools/disposable-pattern.ts`.
3. Wrap resource acquisition in `using()` or add to a `DisposableStack`.
4. Remove existing ad-hoc `try/finally` cleanup blocks.
5. Move file to `packages/tools/` root index export once two or more callsites exist.

## Size
~130 lines. No dependencies beyond TypeScript builtins.
