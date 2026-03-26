# fn-once-async

Ensure an async function is only called once, caching the result.

## Requirements
- onceAsync<T>(fn) wraps async function
- Concurrent calls wait for the first to complete
- Returns cached result on subsequent calls
- throwOnce(fn) re-throws cached error
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/fn-once-async.ts`
