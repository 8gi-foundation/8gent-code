# use-async

React hook for managing async operations with loading/error state.

## Requirements
- useAsync<T>(fn, deps) returns {data, loading, error, refresh}
- Cancels previous call on dep change
- refresh() re-runs manually
- Handles unmount gracefully
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/use-async.ts`
