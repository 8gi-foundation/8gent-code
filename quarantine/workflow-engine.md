# Workflow Engine

## Tool Name
`workflow-engine`

## Description
Simple workflow engine for the 8gent orchestration layer. Supports:

- Sequential step execution
- Parallel step groups (declare sibling IDs on a step)
- Conditional branching - skip steps based on prior step output
- Per-step retry with configurable max attempts
- Workflow state persistence (swappable: in-memory, SQLite, file)
- Resume from a failed step - completed steps are not re-run

## Status
**quarantine** - functionality complete, not yet wired into the agent loop or TUI.

## Integration Path
1. Wire `Workflow` into `packages/orchestration/orchestrator-bus.ts` as a named task type.
2. Add a `workflow` tool definition in `packages/eight/tools.ts` so the agent can create and resume workflows.
3. Swap `InMemoryPersistence` for a SQLite-backed adapter in `packages/memory/` to survive process restarts.
4. Surface active workflows in the TUI activity monitor.

## File
`packages/orchestration/workflow-engine.ts`
