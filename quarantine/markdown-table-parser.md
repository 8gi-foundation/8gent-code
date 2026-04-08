# Tool: markdown-table-parser

## Description

Bidirectional markdown table utility. Parses markdown table strings into structured data (headers, column alignments, rows) and generates formatted tables from arrays with per-column alignment support.

## Status

**quarantine** - self-contained, pending integration review.

## API

```ts
import { parseTable, generateTable } from "../packages/tools/markdown-table-parser";

// Parse a markdown table string
const result = parseTable("| Name | Age |\n|------|-----|\n| Alice | 30 |");
// { headers: ["Name", "Age"], alignments: ["none", "none"], rows: [["Alice", "30"]] }

// Generate a markdown table from data
const md = generateTable(
  [["Alice", "30"], ["Bob", "25"]],
  ["Name", "Age"],
  ["left", "right"]
);
```

## Integration Path

1. Register in `packages/eight/tools.ts` as an agent tool.
2. Use in `benchmarks/autoresearch/` report generation to replace manual table formatting.
3. Use in memory consolidation exports to render memory entries as human-readable tables.

## Files

- `packages/tools/markdown-table-parser.ts` - full implementation (~100 lines)
