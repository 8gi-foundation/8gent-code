# git-branch-cleaner

**Status:** quarantine

## Description

Identifies and cleans stale or merged git branches. Supports dry-run preview before any destructive action and handles both local and remote branch deletion.

## Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `listStale` | `(days?: number) => BranchInfo[]` | Returns branches with no commits in the last N days (default 30) |
| `listMerged` | `() => BranchInfo[]` | Returns branches already merged into main |
| `dryRun` | `(branches: BranchInfo[]) => void` | Prints a preview of branches that would be deleted |
| `clean` | `(branches: BranchInfo[], remote?: boolean) => Promise<CleanResult>` | Deletes branches locally and optionally from origin |

## Usage

```ts
import { listStale, listMerged, dryRun, clean } from "./packages/tools/git-branch-cleaner";

// Preview stale branches (60+ days)
const stale = listStale(60);
dryRun(stale);

// Delete merged branches (local only)
const merged = listMerged();
const result = await clean(merged);
console.log("Deleted:", result.deleted);

// Delete stale branches including remote
const result2 = await clean(stale, true);
```

## Integration Path

- Wire into `packages/tools/index.ts` as an exported tool under `gitBranchCleaner`
- Expose via agent CLI: `bun -e "import {listStale, dryRun} from './packages/tools/git-branch-cleaner.ts'; dryRun(listStale(30))"`
- Optionally surface in TUI maintenance panel or as a `/clean-branches` command
- Consider adding to post-session reflection in `packages/self-autonomy/reflection.ts` for periodic repo hygiene

## Safety

- Never deletes `main`, `master`, or the currently checked-out branch
- Dry-run is the recommended first step before calling `clean()`
- Remote deletion requires explicit `remote = true` opt-in
