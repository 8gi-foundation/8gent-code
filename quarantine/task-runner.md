# task-runner

**Tool name:** task-runner
**Package:** `packages/tools/task-runner.ts`
**Status:** quarantine

## Description

Sequential and parallel task execution with per-task progress tracking, retry support, and event emission. Designed for agent workflow orchestration where named tasks may have dependencies, need retry logic, or must run concurrently within a concurrency limit.

## API

```ts
import { TaskRunner } from "./packages/tools/task-runner";

const runner = new TaskRunner({ concurrency: 2, stopOnFailure: false });

runner
  .register({ name: "fetch", run: async () => fetchData() })
  .register({ name: "parse", run: async () => parseData(), dependsOn: ["fetch"], retries: 2 })
  .register({ name: "save", run: async () => saveData(), dependsOn: ["parse"] });

runner.on("task:done", ({ name, durationMs }) => console.log(`${name} done in ${durationMs}ms`));
runner.on("task:fail", ({ name, error }) => console.error(`${name} failed:`, error));

const results = await runner.run();
```

## Events

| Event | Payload |
|-------|---------|
| `run:start` | `{ total }` |
| `task:start` | `{ name }` |
| `task:retry` | `{ name, attempt, error }` |
| `task:done` | `{ name, result, attempt, durationMs }` |
| `task:fail` | `{ name, error, attempts, durationMs }` |
| `task:skip` | `{ name, reason? }` |
| `run:done` | `{ results }` |

## Integration Path

1. **Agent tool loop** - wire as `packages/tools/task-runner.ts`, import in `packages/eight/tools.ts`
2. **Orchestration layer** - replace ad-hoc `Promise.all` chains in `packages/orchestration/`
3. **Benchmark harness** - use as the task scheduler in `benchmarks/autoresearch/harness.ts`
4. **Validation pipeline** - sequence checkpoint-verify-revert steps in `packages/validation/`

## Constraints

- No external dependencies - uses Node `EventEmitter` only
- Concurrency is capped at `opts.concurrency` (default: 1 = sequential)
- Tasks with failed/skipped dependencies are automatically skipped
- Dependency cycles result in remaining tasks being skipped (no hang)
