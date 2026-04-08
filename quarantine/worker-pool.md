# worker-pool

## Tool Name
`worker-pool`

## Description
Manages a pool of Bun worker threads for CPU-bound tasks. Accepts any serializable function and input data, distributes work across a configurable number of threads (defaulting to CPU count), and queues tasks when all workers are busy.

Exports:
- `WorkerPool` - pool class with `run(fn, data)` for submitting tasks, `terminate()` for graceful shutdown
- `WorkerPoolOptions` - configuration interface (`size`, `maxQueue`)

Key properties:
- `queueLength` - number of tasks waiting for a free worker
- `activeWorkers` - number of workers currently executing

## Status
**quarantine** - self-contained, no integration yet. Tested manually. Ready for wiring.

## Integration Path
1. Import into `packages/eight/agent.ts` - use for CPU-bound tool operations (AST parsing, diff computation, embedding batch jobs) to avoid blocking the main event loop
2. Wire into `packages/ast-index/` - offload graph traversal and impact estimation to worker threads
3. Expose as a shared singleton in `packages/tools/index.ts` so any tool can delegate heavy work without spinning up ad-hoc threads
4. Add pool metrics (`queueLength`, `activeWorkers`) to the TUI activity monitor so the user can see thread saturation at a glance
