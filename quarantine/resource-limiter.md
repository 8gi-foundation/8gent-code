# resource-limiter

## Tool Name
`ResourceLimiter`

## Description
Monitors and limits CPU and memory usage of child processes. Provides configurable thresholds with auto-kill capability when a process exceeds defined resource limits.

## Status
`quarantine` - Under evaluation. Not wired into the agent tool index yet.

## API

| Method | Signature | Description |
|--------|-----------|-------------|
| `setMemoryLimit` | `(mb: number): void` | Set max memory in megabytes |
| `setCpuLimit` | `(percent: number): void` | Set max CPU percent (1-100) |
| `monitor` | `(pid: number): ResourceUsage` | Sample current resource usage for a PID |
| `getUsage` | `(pid: number): ResourceUsage \| null` | Return latest sampled usage |
| `isOverLimit` | `(pid: number): boolean` | True if any limit is exceeded |
| `kill` | `(pid: number): boolean` | SIGKILL the process, return success |

## Platform Notes
- Memory tracking uses `/proc/<pid>/statm` on Linux. Falls back to 0 on macOS/Windows for external PIDs.
- Self-monitoring (`pid === process.pid`) uses `process.memoryUsage().rss` on all platforms.
- CPU percent is a system-wide delta (via `os.cpus()`), not per-PID. Per-PID CPU on macOS requires `ps` or `pidusage` - a future improvement.

## Integration Path
1. Add to `packages/tools/index.ts` export list.
2. Register in the agent tool schema in `packages/eight/tools.ts`.
3. Wire into orchestration layer (`packages/orchestration/`) so worktree subprocesses are monitored during long-running tasks.
4. Optional: expose `/resource-limit` slash command in TUI for manual threshold configuration.

## Source
`packages/tools/resource-limiter.ts`
