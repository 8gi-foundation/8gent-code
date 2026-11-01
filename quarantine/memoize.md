# memoize

Memoize pure functions with configurable cache key and size limit.

## Requirements
- memoize(fn, options?) -> memoized function
- keyResolver: (...args) -> string for custom cache key
- maxSize evicts oldest entries
- cache.clear(), cache.size, cache.has(key)
- TypeScript generics preserve argument and return types

## Status

Quarantine - pending review.

## Location

`packages/tools/memoize.ts`
