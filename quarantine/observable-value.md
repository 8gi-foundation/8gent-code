# observable-value

## Tool Name
`observable-value`

## Description
Reactive observable values with computed derivations for agent state management. Provides three primitives:

- `observable(initial)` - reactive container with `get()`, `set()`, `update()`, and `subscribe()`
- `computed(fn)` - derived value that auto-tracks dependencies and re-evaluates lazily when any dependency changes
- `batch(fn)` - groups multiple mutations so subscribers flush once after all updates

Designed to replace ad-hoc state diffing inside agent loops and tool pipelines. Keeps state coherent across multi-step tasks without manual notification wiring.

## Status
`quarantine`

Implemented and self-contained. Not yet wired into any package or agent loop.

## Integration Path
1. Wire into `packages/eight/agent.ts` - replace manual `prevState` diffing with `observable()` on `AgentState`
2. Use `computed()` in `packages/orchestration/` to derive pool utilisation from individual worker observables
3. Use `batch()` in `packages/permissions/policy-engine.ts` when applying bulk policy updates
4. Expose via `packages/tools/index.ts` once battle-tested in one of the above contexts

## Source
`packages/tools/observable-value.ts` (~150 lines, zero external deps)
