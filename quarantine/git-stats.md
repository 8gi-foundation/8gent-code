# Quarantine: git-stats

## What

Git repository statistics collector - gathers commit frequency, lines added/removed, most active files, and commit type breakdown from local git history. Zero external dependencies.

## File

`packages/tools/git-stats.ts` (~170 lines)

## API

```ts
import { gatherStats, formatStats } from './packages/tools/git-stats.ts';
const stats = await gatherStats('.');
console.log(formatStats(stats));
```

## Exported types

| Field | Type | Description |
|-------|------|-------------|
| `frequency` | `CommitFrequency` | daily/weekly/monthly commit counts, total, first/last dates |
| `lines` | `LineDelta` | total lines added, removed, net across all history |
| `activeFiles` | `ActiveFile[]` | top 20 files by commit count with per-file line deltas |
| `commitTypes` | `CommitTypeBreakdown` | Conventional Commits type distribution with percentages |

## CLI usage

```bash
bun run packages/tools/git-stats.ts
bun run packages/tools/git-stats.ts /path/to/repo
```

## Why quarantined

New file, untested in CI. Needs:

- [ ] Tests for `detectType` and `isoWeek` helpers
- [ ] Wire into `packages/tools/index.ts`
- [ ] Add as agent-callable tool in `packages/eight/tools.ts`
- [ ] Validate on Linux
- [ ] Consider `--since` flag for windowed analysis
- [ ] Consider `--json` output mode
