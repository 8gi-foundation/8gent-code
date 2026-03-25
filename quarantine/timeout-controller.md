# Quarantine: timeout-controller

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/timeout-controller.ts`

---

## What it does

Wraps async operations with configurable timeouts and abort signals. Supports cascading timeouts for nested operations and deadline propagation across the agent tool call stack.

| Export | Signature | Description |
|--------|-----------|-------------|
| `withTimeout` | `(fn, ms, parentSignal?) => Promise<T>` | Wrap a single async function with a timeout and optional parent signal. |
| `TimeoutController` | class | Deadline manager - propagate a single deadline across nested operations via child controllers. |
| `TimeoutError` | class | Thrown when a timeout fires. Carries the `timeout` (ms) that was exceeded. |

---

## Features

| Feature | Support |
|---------|---------|
| Single-call timeout | `withTimeout(fn, ms)` |
| Parent signal propagation | pass `parentSignal` to inherit parent cancellation |
| Cascading child deadlines | `controller.child(ms)` picks the tighter of parent/child |
| Remaining deadline query | `controller.remaining` (ms left) |
| Early cancellation | `controller.cancel()` |
| Clean disposal | `controller.dispose()` clears timer without aborting |
| AbortSignal standard | works with `fetch`, `fs`, and any Web API that accepts signals |

---

## Usage

```ts
import { withTimeout, TimeoutController, TimeoutError } from './packages/tools/timeout-controller.ts';

// Simple single-call timeout
const result = await withTimeout(async (signal) => {
  const res = await fetch('https://api.example.com', { signal });
  return res.json();
}, 5000);

// Deadline across nested operations
const root = new TimeoutController(10_000); // 10s total budget

const step1 = root.child(3000); // up to 3s, but dies with root
await step1.run(async (signal) => doWork(signal));
step1.dispose();

const step2 = root.child(4000); // up to 4s of remaining budget
await step2.run(async (signal) => doMoreWork(signal));
step2.dispose();

root.dispose();
```

---

## Integration path

Not wired into `packages/tools/index.ts` or any agent tool registry. Export and register when needed.

Potential uses:
- `packages/eight/agent.ts` - wrap tool calls with per-tool timeout budgets
- `packages/orchestration/` - enforce deadlines on worktree sub-agents
- `packages/tools/browser/` - timeout fetch and scrape operations
- `packages/daemon/` - wrap handler functions with request-level deadlines
- Any `scripts/` that call external APIs or shell commands
