# number-formatter

**Status:** quarantine

## Description

Self-contained TypeScript utility that formats numbers as human-readable strings. No external dependencies. No side effects.

## Exports

| Function | Input | Example Output |
|----------|-------|----------------|
| `formatBytes(n, decimals?)` | byte count | `1.5 KB`, `2.3 GB` |
| `formatNumber(n, decimals?)` | any number | `1.2K`, `3.4M`, `42` |
| `formatWithCommas(n)` | any number | `1,234,567` |
| `formatPercent(n, decimals?)` | 0.0-1.0 decimal | `75.3%` |
| `formatDuration(ms)` | milliseconds | `500ms`, `1m 1s`, `2h 30m` |
| `formatOrdinal(n)` | integer | `1st`, `2nd`, `11th`, `21st` |
| `formatSignificant(n, sigFigs?)` | any number | `0.00123`, `12300` |

## Source

`packages/tools/number-formatter.ts`

## Integration Path

1. Export from `packages/tools/index.ts` once validated
2. Use in TUI display layer for token counts, file sizes, durations
3. Use in benchmark reporting for score formatting
4. Use in memory stats display (`packages/memory/health.ts`)

## Validation Checklist

- [ ] Unit tests passing (none yet - add in `packages/tools/__tests__/number-formatter.test.ts`)
- [ ] Exported from `packages/tools/index.ts`
- [ ] Used in at least one production path
- [ ] Edge cases verified: 0, negative, Infinity, NaN
