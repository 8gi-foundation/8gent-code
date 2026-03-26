# async-retry

Retry async operations with configurable backoff strategies.

## Requirements
- retry(fn, opts) retries on thrown errors
- opts: maxAttempts, delay, backoff (linear|exponential), shouldRetry(err)
- onRetry(attempt, err) callback
- Returns first successful result
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/async-retry.ts`
