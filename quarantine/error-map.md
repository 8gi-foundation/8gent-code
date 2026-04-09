# error-map

**Status:** Quarantined - awaiting integration review
**File:** `packages/tools/error-map.ts`
**Lines:** ~130

## What it does

Maps error classes to recovery strategy handlers. Dispatches any thrown `Error` to
the most specific registered handler by walking the prototype chain. Centralises
recovery logic in agent loops, tool runners, and daemon protocol handlers.

## API

| Method | Description |
|--------|-------------|
| `register(ErrorClass, handler, priority?)` | Bind a handler to an error class (and subclasses). Higher priority wins on ties. |
| `handle(error)` | Async dispatch - walks prototype chain, invokes best match, falls back to default. |
| `handleSync(error)` | Synchronous variant - throws if a matched handler returns a Promise. |
| `setDefault(handler)` | Fallback handler invoked when no class matches. |
| `has(error)` | Check whether a handler exists without invoking it. |

`handle()` returns a `RecoveryResult`:

```ts
{ matched: true;  handlerKey: string }  // name of matched ctor or "__default__"
{ matched: false }                       // no handler and no default
```

## Key features

- **Inheritance matching** - a handler for `AppError` will catch `NotFoundError` if no
  more-specific handler is registered.
- **Priority** - when multiple entries are registered for the exact same class, the
  highest `priority` value wins.
- **Default handler** - catch-all for unregistered error types.
- **Fluent API** - `register()` and `setDefault()` return `this` for chaining.
- No external dependencies.

## Usage example

```ts
import { ErrorMap } from "./error-map";
import { NotFoundError, ValidationError, AppError } from "./structured-error";

const map = new ErrorMap()
  .register(NotFoundError, (err) => {
    console.warn("Not found:", err.message);
  }, 10)
  .register(ValidationError, async (err) => {
    await reportToSentry(err);
  })
  .register(AppError, (err) => {
    // Catches any AppError subclass not handled above
    logger.error(err);
  })
  .setDefault((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });

// In an agent tool runner:
try {
  await runTool(tool);
} catch (err) {
  const result = await map.handle(err as Error);
  if (!result.matched) throw err;
}
```

## Integration notes

- Pairs with `structured-error.ts` - use `AppError` subclasses as keys.
- Drop into `packages/eight/agent.ts` tool-call catch block for per-error-type recovery.
- Daemon protocol handlers can map error types to WebSocket error codes.
- Register a `TimeoutError` handler that calls `agent.restoreFromCheckpoint()`.

## Promotion criteria

- [ ] Integrate into `packages/eight/agent.ts` tool-runner catch block
- [ ] Register handlers for errors from `structured-error.ts`
- [ ] Add to `packages/tools/index.ts` exports
- [ ] Add test file `packages/tools/error-map.test.ts`
