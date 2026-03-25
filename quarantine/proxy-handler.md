# proxy-handler

**Status:** quarantine

## Description

JavaScript Proxy-based object interceptors for logging, validation, and access control.
Wraps any object with a transparent `Proxy` that intercepts `get`, `set`, `delete`, and `has`
operations without modifying the original object's shape or prototype.

## Exports

| Function | Purpose |
|----------|---------|
| `createProxy(target, options)` | Base factory - attach any combination of handlers |
| `readOnly(obj)` | Throws on any write or delete, deep by default |
| `logged(obj)` | Returns `{ proxy, log }` - live `AccessLog[]` for every operation |
| `validated(obj, validators)` | Per-key validation functions; throw on bad values |
| `deepProxy(obj, options)` | Recursively wraps nested objects on access |

## Integration Path

1. **Permissions layer** - wrap `packages/permissions/policy-engine.ts` config objects with
   `readOnly()` to prevent accidental mutation after load.
2. **Memory store** - wrap episodic memory entries with `logged()` to trace read patterns
   and feed into `packages/self-autonomy/reflection.ts`.
3. **Tool validation** - use `validated()` on tool input payloads as a lightweight schema
   guard before passing to `packages/eight/tools.ts`.
4. **Agent state** - wrap the live agent state object with `deepProxy` + `onAccess` hook
   to drive the activity monitor in `apps/tui`.

## File

`packages/tools/proxy-handler.ts` (~110 lines, zero dependencies)
