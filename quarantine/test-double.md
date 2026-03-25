# Quarantine: test-double

**Status:** Quarantine - awaiting integration review
**Package:** `packages/tools/test-double.ts`
**Branch:** `quarantine/test-double`

---

## What It Does

Three test doubles for use in any package test suite.

### `spy(fn)`

Wraps an existing function without changing its behavior. Records every call.

```ts
import { spy } from '../packages/tools/test-double.ts';

const original = (x: number) => x * 2;
const watched = spy(original);

watched(3); // returns 6 as normal
console.log(watched.callCount);    // 1
console.log(watched.calledWith);   // [[3]]
console.log(watched.returnValues); // [6]
watched.reset(); // clears all recorded data
```

### `stub()`

Creates a fake function from scratch with configurable return behavior.

```ts
import { stub } from '../packages/tools/test-double.ts';

const fakeRead = stub<string>().returns('file contents');
fakeRead('/any/path'); // 'file contents'

// Sequence mode - each call returns next value in order
const seq = stub<number>().returnsSequence(1, 2, 3);
seq(); // 1, seq(); // 2, seq(); // 3 (stays at last)

// Throw mode
const bad = stub().throws(new Error('network down'));
bad(); // throws Error('network down')
```

### `mock(obj, method)`

Replaces a method on an object with a spy-wrapped version. Call `restore()` to undo.

```ts
import { mock } from '../packages/tools/test-double.ts';

const db = { query: (sql: string) => ({ rows: [] }) };
const m = mock(db, 'query');

db.query('SELECT 1');
console.log(m.callCount);  // 1
console.log(m.calledWith); // [['SELECT 1']]

m.restore(); // db.query is back to original
```

---

## Tracked Data (all three)

| Property | Type | Description |
|----------|------|-------------|
| `callCount` | `number` | Total invocations |
| `calledWith` | `unknown[][]` | Arguments per call |
| `returnValues` | `unknown[]` | Return value per call |
| `calls` | `CallRecord[]` | Full per-call record including error info |

---

## Integration Notes

- No external dependencies - pure TypeScript
- Works with Bun's built-in test runner (`bun test`)
- `spy` and `stub` are stateless wrappers - no side effects outside the call record
- `mock` mutates the target object - always call `restore()` in test teardown
- `reset()` on all three clears recorded call data without restoring originals

---

## Out of Scope (intentional)

- No automatic timer-based assertions
- No deep equality built in - use your test runner's `expect()` for value assertions
- No async-specific batching - async functions work, returned promises are tracked as-returned
