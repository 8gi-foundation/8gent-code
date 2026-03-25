# Quarantine: Worktree Cleanup Utility

## Problem

Agent worktrees accumulate in `.claude/worktrees/` and are never cleaned up. Each stale worktree holds a full checkout, wasting disk space and cluttering `git worktree list`.

## Solution

`scripts/cleanup-worktrees.ts` - a Bun script that:

1. Lists all git worktrees via `git worktree list --porcelain`
2. Filters to agent worktrees (path contains `/worktrees/agent-`)
3. Checks each for active processes via `lsof`
4. Removes stale ones with `git worktree remove --force`
5. Runs `git worktree prune` to clean dangling refs

## Usage

```bash
# Dry run - see what would be cleaned
bun run scripts/cleanup-worktrees.ts

# Actually remove stale worktrees
bun run scripts/cleanup-worktrees.ts --force
```

## Safety

- Dry run by default - requires `--force` to actually remove anything
- Only targets agent worktrees (skips main and non-agent worktrees)
- Checks for active processes before removal - won't kill running agents
- Reports failures individually without aborting the whole run

## Graduation criteria

- Tested on a repo with 30+ stale worktrees
- Correctly preserves active worktrees
- Disk space reclaimed is measurable
