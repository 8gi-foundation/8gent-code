# Task Scheduler

## Tool Name
`task-scheduler`

## Description
Time-based task scheduler for agent automation. Supports one-shot (fire once after a delay) and recurring (repeat on interval) jobs. Each job can be independently paused, resumed, or cancelled. Provides a job listing API for introspection.

API surface:
- `scheduleOnce(fn, delayMs)` - run `fn` once after `delayMs`
- `scheduleRecurring(fn, intervalMs)` - run `fn` every `intervalMs`
- `cancel(id)` - permanently stop a job
- `pause(id)` - suspend a job without losing its schedule
- `resume(id)` - resume a paused job
- `listJobs()` - return a summary of all tracked jobs
- `clear()` - cancel and remove all jobs

## Status
**quarantine** - self-contained, not yet wired into the agent tool registry or any package exports.

## Integration Path
1. Add `Scheduler` to `packages/tools/index.ts` exports
2. Register as an agent tool in `packages/eight/tools.ts` with typed input schema
3. Expose to the TUI via a `/scheduler` command or activity monitor panel
4. Wire `clear()` into session teardown to prevent orphaned timers across agent restarts
