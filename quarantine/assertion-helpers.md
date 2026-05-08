# Quarantine: assertion-helpers

**Status:** Quarantined - pending integration review
**File:** `packages/tools/assertion-helpers.ts`
**Size:** ~130 lines

## What it does

Five assertion utilities that validate invariants during development and strip to no-ops in production (`NODE_ENV === "production"`).

| Export | Purpose |
|--------|---------|
| `assert(condition, message)` | General-purpose truthy check |
| `assertNever(x)` | Exhaustive union check - compile-time `never` guard |
| `assertDefined<T>(val, message?)` | Null/undefined check with type narrowing |
| `assertType<T>(val, guard, message?)` | Type-guard predicate check |
| `invariant(condition, msg)` | Program invariant enforcement |

## Production behavior

All functions check `process.env.NODE_ENV === "production"` at the top and return immediately. No thrown errors, no overhead, no bundle cost (tree-shakeable).

## Usage

```typescript
import { assert, assertNever, assertDefined, assertType, invariant } from "../tools/assertion-helpers";

// assert - general condition
assert(items.length > 0, "items must not be empty");

// assertNever - exhaustive switch
switch (action.type) {
  case "read":  return handleRead();
  case "write": return handleWrite();
  default:      return assertNever(action.type);
}

// assertDefined - null/undefined guard
const el = assertDefined(document.getElementById("root"), "#root must exist");

// assertType - type-guard predicate
function isString(v: unknown): v is string { return typeof v === "string"; }
const name = assertType(rawInput, isString, "name must be a string");

// invariant - correctness guarantee
invariant(queue.size >= 0, "queue size cannot be negative");
```

## Integration path

1. Import into `packages/eight/agent.ts` for agent loop invariants
2. Import into `packages/memory/store.ts` for memory consistency checks
3. Replace any ad-hoc `if (!x) throw` patterns across the codebase

## Promotion criteria

- [ ] Used in at least one package (agent, memory, or permissions)
- [ ] No regressions in production build (NODE_ENV check verified)
- [ ] Type narrowing confirmed working in tsconfig strict mode
