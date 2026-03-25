# fn-compose

## Description

Function composition utilities for building left-to-right pipelines (`flow`) and right-to-left compositions (`compose`), with async variants and two helper primitives. Useful anywhere a sequence of transformations needs to be expressed as a single callable unit.

## Status

**quarantine** - self-contained, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `flow` | `(...fns) => (a) => result` | Left-to-right composition - fn1 result feeds fn2, then fn3, etc. |
| `compose` | `(...fns) => (a) => result` | Right-to-left composition - last fn runs first (mathematical convention) |
| `flowAsync` | `(...fns) => (a) => Promise<result>` | Left-to-right async pipeline - each step is awaited before the next |
| `composeAsync` | `(...fns) => (a) => Promise<result>` | Right-to-left async composition |
| `identity` | `(x: T) => T` | Returns the argument unchanged - useful as a default no-op |
| `constant` | `(x: T) => () => T` | Returns a function that always returns x regardless of input |

## Integration Path

1. Wire into `packages/tools/index.ts` export barrel.
2. Use in `packages/self-autonomy/reflection.ts` to build transform pipelines over session data.
3. Use in `packages/validation/` to compose validator functions into a single check chain.
4. Use in `packages/eight/agent.ts` middleware-style pre/post-processing around tool calls.

## Source

`packages/tools/fn-compose.ts` - 60 lines, zero dependencies, pure TypeScript.
