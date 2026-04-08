# option-type

## Tool Name
`option-type`

## Description
Rust-style `Option<T>` for safe nullable value handling in TypeScript. Replaces
scattered `null`/`undefined` checks with a composable, type-safe monad. Provides
`Some`/`None` constructors, `map`, `flatMap`, `filter`, `unwrap`, `unwrapOr`,
`match` (pattern matching), `fromNullable`, `zip`, `firstSome`, and `toNullable`.

No runtime dependencies. ~130 lines. Drop-in utility for any package in the repo.

## Status
**quarantine** - implemented and self-contained, not yet wired into the agent or
any existing package.

## Integration Path
1. Import from `packages/tools/option-type.ts` in any package that currently uses
   `T | null | undefined` return types.
2. Candidate consumers: `packages/memory/store.ts` (nullable recall results),
   `packages/self-autonomy/reflection.ts` (optional session data), task-router
   model selection logic.
3. Promote to `packages/core/` or re-export from `packages/tools/index.ts` once
   at least two consumers are wired.
4. Add unit tests under `packages/tools/__tests__/option-type.test.ts` before
   promotion.
