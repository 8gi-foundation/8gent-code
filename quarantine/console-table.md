# Quarantine: console-table

## What

Improved `console.table` replacement that renders arrays of objects as formatted terminal tables with column alignment, ANSI header colors, row striping, compact mode, and GitHub-flavored markdown output.

## File

`packages/tools/console-table.ts` (~145 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { consoleTable, printTable } from './packages/tools/console-table.ts';

// Returns formatted string
const output = consoleTable(data, options);

// Prints directly to stdout
printTable(data, { headerColors: true, rowStriping: true });
```

## Example output (ANSI mode)

```
 name          | score | status
---------------+-------+----------
 Alice         |    98 | pass
 Bob           |    72 | pass
 Charlie       |    41 | fail
```

## Example output (markdown mode)

```
| name    | score | status |
| ------- | ----: | ------ |
| Alice   |    98 | pass   |
| Bob     |    72 | pass   |
| Charlie |    41 | fail   |
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxColWidth` | `number` | `40` | Max chars per column before truncation |
| `headerColors` | `boolean` | `true` | Bold cyan ANSI header |
| `rowStriping` | `boolean` | `true` | Dim alternating rows |
| `compact` | `boolean` | `false` | Remove column padding |
| `markdown` | `boolean` | `false` | Emit GFM table instead of ANSI |
| `columns` | `string[]` | auto | Explicit column order |
| `align` | `Record<string, 'left'\|'right'\|'center'>` | auto | Per-column alignment override |

Auto-alignment: numeric columns right-align, string columns left-align.

## Integration path

- [ ] Add exports to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: fixture data with expected ANSI and markdown strings
- [ ] Wire into TUI for benchmark results display, memory stats, worktree pool status
- [ ] Add `--format=table|markdown|json` flag to relevant CLI commands
