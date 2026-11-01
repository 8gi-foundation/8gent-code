# debounce

Debounce and throttle higher-order functions with cancellation support.

## Requirements
- debounce(fn, delayMs, options?) - trailing/leading edge
- throttle(fn, intervalMs) - limit call rate
- Both return a wrapped function with .cancel() method
- debounce returns a promise resolving to the fn's return value
- TypeScript generics preserve argument and return types

## Status

Quarantine - pending review.

## Location

`packages/tools/debounce.ts`
