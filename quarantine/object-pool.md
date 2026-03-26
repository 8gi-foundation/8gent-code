# object-pool

Reusable object pool to reduce GC pressure.

## Requirements
- ObjectPool<T>(factory, reset, maxSize) manages instances
- acquire() gets instance from pool or creates new
- release(obj) returns to pool after reset
- size() returns current pool depth
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/object-pool.ts`
