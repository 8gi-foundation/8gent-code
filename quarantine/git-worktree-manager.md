# git-worktree-manager

## Tool Name
`GitWorktreeManager`

## Description
Pool-managed git worktrees for parallel development workflows. Creates, runs commands in, and removes isolated git worktrees. Caps pool at 4 concurrent worktrees. Auto-prunes worktrees idle for more than 30 minutes.

Distinct from the existing `WorktreeManager` (which is agent-lifecycle focused): this tool targets developer-facing parallel workflows with explicit pool management, command execution, and stale cleanup.

## Status
`quarantine` - implemented, not yet wired into the agent or TUI.

## Key Capabilities
- `create(label)` - allocate a new worktree branch under `.8gent/parallel-worktrees/`
- `run(id, command)` - execute a shell command in the worktree, returns stdout/stderr/exitCode
- `remove(id)` - tear down worktree and delete its branch
- `list()` - enumerate active pool entries
- `pruneStale()` - remove all worktrees idle > 30 min
- `removeAll()` - full shutdown cleanup

## Integration Path
1. Wire into `packages/orchestration/index.ts` exports.
2. Expose as a tool in `packages/eight/tools.ts` so the agent can spin up parallel worktrees on demand.
3. Surface pool status in the TUI activity monitor (`apps/tui/src/screens/`).
4. Connect to `WorktreePool` eviction logic for unified pool governance.

## Files
- Implementation: `packages/orchestration/git-worktree-manager.ts`
