# result

Result/Either monad for type-safe error handling without exceptions.

## Requirements
- ok(value: T) -> Result<T, never>
- err(error: E) -> Result<never, E>
- map, flatMap, mapErr on Result
- unwrap() throws if Err, unwrapOr(default) for safe access
- match(result, { ok, err }) pattern matching

## Status

Quarantine - pending review.

## Location

`packages/tools/result.ts`
