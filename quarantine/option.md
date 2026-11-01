# option

Option/Maybe monad for nullable value handling.

## Requirements
- some(value: T) -> Option<T>
- none() -> Option<never>
- fromNullable(val) -> Option<T>
- map, flatMap, filter, getOrElse
- isSome, isNone type guards

## Status

Quarantine - pending review.

## Location

`packages/tools/option.ts`
