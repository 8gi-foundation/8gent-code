# quarantine/hook-system

**Status:** Quarantine - under review before promotion to active package.

## What it is

A lightweight lifecycle hook system. Consumers register named hooks in `before` or `after` phases. When an event fires, all hooks for that phase run in priority order, each receiving (and optionally mutating) a shared context object.

## Files

- `packages/tools/hook-system.ts` - full implementation (~130 lines)

## API

```ts
import {
  HookSystem,    // class - main entry point
  HookPhase,     // 'before' | 'after'
  HookFn,        // (context: T) => Promise<T | void> | T | void
  HookEntry,     // { id, name, phase, fn, priority }
  HookCallResult // { context, ran, skipped }
} from "./packages/tools/hook-system";
```

## Usage examples

```ts
const hooks = new HookSystem<{ user: string; allowed: boolean }>();

// Register a before hook (priority 10 runs before priority 50)
const id = hooks.addHook('request', 'before', async (ctx) => {
  return { ...ctx, allowed: ctx.user !== 'blocked' };
}, 10);

// Register an after hook
hooks.addHook('request', 'after', (ctx) => {
  console.log(`Request finished for ${ctx.user}`);
});

// Fire hooks
const { context, ran, skipped } = await hooks.callHook('request', 'before', {
  user: 'alice',
  allowed: false,
});
// context.allowed === true

// Remove by ID
hooks.removeHook(id);

// Inspect registered hooks
hooks.listHooks('request');           // both phases
hooks.listHooks('request', 'before'); // before only
```

## Behaviour

- Hooks run in ascending priority order (default priority 50).
- Each hook receives the context returned by the previous hook. If a hook returns `void` or `undefined`, the context is passed through unchanged.
- If a hook throws, it is skipped (ID appears in `result.skipped`) and the next hook runs with the last good context.
- `clear(name?)` removes all hooks for a name, or all hooks globally.

## Promotion criteria

- [ ] Unit tests passing (before/after ordering, priority, error isolation, context mutation, removeHook)
- [ ] Used in at least one real lifecycle point (e.g. agent turn start/end)
- [ ] Reviewed by a second agent or James
