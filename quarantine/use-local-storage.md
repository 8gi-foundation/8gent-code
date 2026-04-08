# use-local-storage

React hook for synced localStorage state.

## Requirements
- useLocalStorage<T>(key, initial) returns [value, setter, remove]
- Serializes/deserializes JSON
- Syncs across tabs via storage event
- Handles SSR (no window)
- Zero external dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/use-local-storage.ts`
