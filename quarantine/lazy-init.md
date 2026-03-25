# lazy-init

Lazy initialization wrappers for expensive resources.

## Requirements
- lazy(factory: () => T) -> { value: T } computed on first access
- lazyAsync(factory: () => Promise<T>) -> { get: () => Promise<T> }
- reset(lazy) clears cached value for re-init
- isInitialized(lazy) -> boolean
- Thread-safe init guard (no double-init race)

## Status

Quarantine - pending review.

## Location

`packages/tools/lazy-init.ts`
