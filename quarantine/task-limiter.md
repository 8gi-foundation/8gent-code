# Quarantine: task-limiter

**Status:** Quarantine - not yet wired into production paths
**Package:** `packages/tools/task-limiter.ts`
**Size:** ~130 lines, zero external dependencies

## What it does

`TaskLimiter` caps how many async tasks run simultaneously. Excess tasks queue automatically and execute as slots free up.

## API

```ts
import { TaskLimiter } from "./packages/tools/task-limiter.ts";

const limiter = new TaskLimiter(3); // max 3 concurrent

// Enqueue tasks - returns a promise that resolves with the task result
const result = await limiter.run(async () => fetchSomething());

// Inspect state
limiter.activeCount;  // tasks currently running
limiter.pendingCount; // tasks waiting in queue

// Pause queued tasks from starting (running tasks continue)
limiter.pause();
limiter.resume();

// Reject all queued (not-yet-started) tasks
limiter.clearQueue(new Error("Shutting down"));

// Callback when queue empties and nothing is running
limiter.onDrain(() => console.log("all done"));
```

## Intended use cases

- Agent tool dispatch: prevent 20 simultaneous `run_command` or `web_fetch` calls
- Orchestration layer: cap sub-agent spawns to `maxConcurrent = 4` (matching WorktreePool)
- Benchmark harness: controlled parallel test execution without overloading Ollama

## Integration notes

- Not yet imported in `packages/tools/index.ts` - deliberate; quarantine means "working but not wired"
- No dependency on the agent loop, memory, or any other package - safe to promote at any time
- `clearQueue` does not cancel in-flight tasks (no AbortController coupling) - caller owns that

## Promotion checklist

- [ ] Add to `packages/tools/index.ts` exports
- [ ] Wire into agent tool dispatch or orchestration layer
- [ ] Add integration test in `benchmarks/categories/abilities/`
- [ ] Document in CLAUDE.md Core Ability Packages table if promoted to a first-class power
