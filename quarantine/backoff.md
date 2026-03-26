# backoff

Configurable backoff strategies for retry delays.

## Requirements
- exponential(attempt, base, max) returns ms delay
- linear(attempt, step, max) returns ms delay
- constant(delay) returns fixed delay
- jitter(delay, factor) adds random variance
- withJitter(strategy, factor) wraps any strategy

## Status

Quarantine - pending review.

## Location

`packages/tools/backoff.ts`
