# dag-scheduler

## Tool Name
`DAGScheduler`

## Description
Directed acyclic graph task scheduler for parallel execution. Define tasks with named IDs and dependency lists, and the scheduler handles topological sorting, detects cycles, and runs all dependency-free tasks concurrently. Tasks that share no dependencies execute in parallel; tasks with dependencies wait until their deps complete.

Key behaviors:
- Topological sort validates the graph is acyclic before execution starts
- Independent tasks run in parallel via `Promise.race` dispatching
- Failed deps propagate - downstream tasks are skipped with a clear error
- Per-task result records include status, result/error, and timing

## Status
`quarantine`

Not yet wired into the Eight agent tool registry. No permissions policy applied. Safe to test in isolation.

## Integration Path
1. Register in `packages/eight/tools.ts` alongside existing tool definitions
2. Add a NemoClaw policy entry in `packages/permissions/` if tasks involve filesystem or network ops
3. Expose as an Eight tool action: `dag_schedule` with a JSON payload of task definitions and a `run` callback resolver
4. Add to the orchestration layer in `packages/orchestration/` for multi-step agent plans that benefit from parallel sub-task execution
5. Wire result summary into the session checkpoint so progress survives interruption

## Location
`packages/tools/dag-scheduler.ts`

## Exports
- `DAGScheduler<T>` - main scheduler class
- `Task<T>` - task definition interface (`id`, `deps`, `run`)
- `TaskResult<T>` - result record interface
