# quarantine/table-renderer

**Status:** Quarantined - ready for review before promotion

## What it does

`packages/tools/table-renderer.ts` renders data arrays to ANSI terminal output
using Unicode box-drawing characters. Zero external dependencies. Auto-sizes
columns, supports per-column alignment and color, compact ASCII fallback mode,
cell truncation with ellipsis, and optional row separators.

## Features

| Feature | Description |
|---------|-------------|
| Unicode borders | Box-drawing top/mid/bottom rows, degrades to compact ASCII mode |
| Auto column sizing | Scans all rows to fit the widest value, respects maxWidth cap |
| Alignment | left (default), right, center per column |
| Cell colors | cyan, yellow, green, blue, red, dim, bold per column |
| Header color | Configurable, defaults to bold |
| Truncation | Long cells cut at maxWidth with ellipsis appended |
| Compact mode | ASCII borders (+-+) for environments without Unicode support |
| Row separators | Optional mid-row dividers between data rows |
| Caption | Optional dim label rendered above the table |
| Column inference | When no columns option given, object keys become headers |

## API

```ts
import { renderTable } from './packages/tools/table-renderer.ts';
import type { ColumnDef, TableOptions } from './packages/tools/table-renderer.ts';

const output = renderTable(rows, options);
process.stdout.write(output + '\n');
```

### renderTable(rows, options?)

| Param | Type | Description |
|-------|------|-------------|
| rows | array | Objects or arrays - all rows same shape |
| options.columns | ColumnDef[] | Column definitions (inferred if omitted) |
| options.compact | boolean | Use ASCII borders (default: false) |
| options.defaultMaxWidth | number | Max width for any auto-sized column (default: 40) |
| options.padding | number | Cell padding on each side (default: 1) |
| options.rowSeparators | boolean | Draw separators between data rows (default: false) |
| options.headerColor | CellColor | Color applied to header cells (default: bold) |
| options.caption | string | Caption line above the table |

### ColumnDef

| Field | Type | Description |
|-------|------|-------------|
| header | string | Column label |
| key | string or number | Property key or array index |
| align | left/right/center | Cell alignment (default: left) |
| maxWidth | number | Truncate cells longer than this |
| color | CellColor | ANSI color for data cells |
| minWidth | number | Minimum column width |

## Usage example

```ts
const rows = [
  { name: 'Eight',     version: '1.2.0', status: 'live',    score: 94 },
  { name: 'Benchmark', version: '0.9.1', status: 'staging', score: 88 },
];

const out = renderTable(rows, {
  columns: [
    { header: 'Package', key: 'name',    color: 'cyan' },
    { header: 'Version', key: 'version', align: 'right', color: 'dim' },
    { header: 'Status',  key: 'status',  color: 'green' },
    { header: 'Score',   key: 'score',   align: 'right', color: 'yellow' },
  ],
  caption: 'Build summary',
});

process.stdout.write(out + '\n');
```

## Constraints

- Zero deps - pure string manipulation, no npm packages
- Terminal ANSI output only - no HTML, no React/Ink
- Single-line cells only - multi-line cell wrapping is out of scope (v1)
- No colspan/rowspan - flat grid only

## Promotion criteria

- [ ] Used in at least one screen (e.g. BenchmarkDashboard, session analytics)
- [ ] Tested against real agent output data (benchmark scores, memory stats)
- [ ] Multi-line cell wrapping added if tables with long prose are needed
