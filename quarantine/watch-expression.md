# watch-expression

## Tool Name
`watch-expression`

## Description
Watches object properties (including deep nested paths) and evaluates registered expressions on each poll cycle. Triggers callbacks when values change and optional conditions are met.

Key capabilities:
- Register watch expressions on dot-separated object paths (e.g. `user.profile.age`)
- Configurable poll interval (default: 100ms)
- Optional condition function - callback fires only when the condition returns true
- Deep path watching with JSON-equality comparison for object values
- Returns an unwatch function per registration for granular cleanup
- `evaluate()` can be called manually (no polling required)

## Status
**quarantine** - Self-contained, no external deps. Not yet wired into the agent tool registry.

## Integration Path
1. Add to `packages/tools/index.ts` exports
2. Register in `packages/eight/tools.ts` under a `watch_expression` tool definition
3. Agent can call `new Watcher(stateObject).watch({ path, callback })` to monitor agent-internal state, live config, or user preferences for reactive side-effects

## File
`packages/tools/watch-expression.ts`

## Exported API
```ts
class Watcher {
  constructor(target: Record<string, unknown>, pollMs?: number)
  watch(options: WatchOptions): () => void  // returns unwatch fn
  unwatchAll(): void
  start(): void
  stop(): void
  evaluate(): void
  setTarget(target: Record<string, unknown>): void
}
```
