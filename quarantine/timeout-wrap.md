# timeout-wrap

Wrap any promise with a timeout that rejects after a deadline.

## Requirements
- withTimeout(promise, ms, message?) -> Promise<T>
- Cleans up the timer on resolution
- Throws TimeoutError with configurable message
- raceWithTimeout(promises, ms) races multiple promises
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/timeout-wrap.ts`
