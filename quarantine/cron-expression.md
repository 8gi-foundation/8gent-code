# cron-expression

## Description

Self-contained cron expression parser. Parses 5-field cron expressions (minute hour dom month dow), calculates next N run times, checks if a given date matches an expression, and generates human-readable descriptions.

Supports: wildcards (`*`), ranges (`1-5`), steps (`*/10`, `0-30/5`), and comma-separated lists (`1,15,30`). Also accepts English month/day-of-week abbreviations (e.g. `mon`, `jan`).

## Status

`quarantine` - standalone utility, no external dependencies, not yet wired into the agent tool registry.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `parseCron` | `(expr: string) => CronParsed` | Parse expression into field arrays |
| `nextRun` | `(expr, after?, count?) => Date[]` | Calculate next N run times |
| `matches` | `(expr, date) => boolean` | Check if a date satisfies the expression |
| `describe` | `(expr) => string` | Human-readable description of the schedule |

## Integration Path

1. Register in `packages/eight/tools.ts` as a scheduling utility tool.
2. Wire into the proactive package (`packages/proactive/cron-manager.ts`) to schedule recurring agent tasks.
3. Expose as a CLI command: `8gent cron "*/5 * * * *"` to preview next run times.

## Location

`packages/tools/cron-expression.ts`
