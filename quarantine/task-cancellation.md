# Quarantine: task-cancellation

**Status:** quarantine - needs integration review before wiring into agent loop

## What

Cooperative cancellation tokens for long-running async tasks. Inspired by the .NET CancellationToken pattern, rebuilt from scratch in ~130 lines.

## Why

The agent runs multiple long-running tasks (tool calls, model streams, worktree ops). Today there is no clean way to propagate a cancel signal across an async call stack. ESC handling in `packages/eight/agent.ts` calls `abort()` on the AI SDK stream but does not reach into nested tool calls or sub-agents.

## Core problem

One sentence: long-running tasks cannot be cooperatively cancelled without coupling to global state.

## What this is NOT doing

- Not replacing AbortController for HTTP (use that for fetch)
- Not wiring into the agent loop (that is the next step, not this PR)
- Not a scheduler or timeout utility

## Files

| File | Purpose |
|------|---------|
| `packages/tools/task-cancellation.ts` | CancellationToken, CancellationTokenSource, linked tokens |

## API

```ts
import { CancellationTokenSource, CancellationToken, CancellationError } from "./packages/tools/task-cancellation";

// Create a source and pass the token into tasks
const cts = new CancellationTokenSource();

async function myTask(token: CancellationToken) {
  await step1();
  token.throwIfCancelled(); // yield point check
  await step2();
  token.throwIfCancelled();
}

// Cancel from outside
cts.cancel("user pressed ESC");

// Linked tokens - cancel when either parent cancels
const parent = new CancellationTokenSource();
const child = CancellationTokenSource.createLinked(parent.token);
```

## Integration path (NEXT, not in this PR)

1. Pass a CancellationToken from agent.abort() into tool call handlers in packages/eight/tools.ts
2. Thread the token through worktree ops in packages/orchestration/
3. Add timeout-based auto-cancel for stuck tasks

## Success metric

Zero regressions. Agent loop unchanged. Token can be imported and used in a tool handler with throwIfCancelled() at every await boundary.
