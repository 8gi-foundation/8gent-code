# pipe-operator

**Tool name:** pipe-operator
**Package:** `packages/tools/pipe-operator.ts`
**Status:** quarantine

## Description

Functional pipe and compose utilities for data transformation chains.

Exports:
- `pipe(value, fn1, fn2, ...)` - left to right composition, up to 6 steps (overloaded, typed)
- `compose(fn1, fn2, ...)` - right to left composition, returns a composed function
- `asyncPipe(value, fn1, fn2, ...)` - left to right, each step can be sync or async
- `tap(fn)` - run a side effect, pass value through unchanged
- `asyncTap(fn)` - await a side effect, then pass value through
- `branch(predicate, ifTrue, ifFalse?)` - conditionally apply a transformation
- `asyncBranch(predicate, ifTrue, ifFalse?)` - async conditional branching

All overloads are fully typed. No dependencies.

## Integration path

1. Import into agent tool chains wherever data flows through multiple transform steps.
2. Replace manual `let result = x; result = f1(result); result = f2(result)` patterns.
3. `asyncPipe` is the primary entry point for agent pipelines that mix I/O and pure transforms.
4. `tap` is useful for logging/debugging mid-chain without breaking the chain.
5. Wire into `packages/eight/tools.ts` as a utility if agent-side transformation chains grow.

## Notes

- No external deps - pure TypeScript.
- Overloads stop at 6 steps; use `reduce` or nest `pipe` calls for longer chains.
- `branch` and `asyncBranch` added for conditional logic inside pipelines, avoiding imperative `if` blocks.
