# git-blame-analyzer

**Status:** quarantine

## Description

Analyzes `git blame` output to surface code ownership patterns, contribution hotspots, and per-file author statistics. Useful for routing code reviews to the right owner and identifying high-churn files.

## Exports

- `analyzeBlame(filePath: string): BlameReport` - single file analysis
- `analyzeRepoOwnership(files: string[]): RepoOwnershipReport` - multi-file rollup

## Output shape

- Per-file: author list ranked by line count, ownership percentages, last-modified date
- Repo-wide: top contributors by total lines, cross-file ownership breakdown

## Integration path

1. Wire into `packages/tools/index.ts` as a registered tool
2. Expose as CLI command: `8gent blame <file>` or `8gent blame --repo`
3. Use in code-review routing: pass PR diff files through `analyzeRepoOwnership`, suggest reviewers by highest ownership percentage
4. Optional: pipe hotspot data into `packages/memory/store.ts` as procedural memory so Eight learns which authors own which modules over time

## Notes

- Requires git to be available in PATH
- Porcelain format used for reliable parsing - not subject to locale changes
- `files` field on `AuthorStats` uses `Set<string>` - serialize with `Array.from()` before JSON output
