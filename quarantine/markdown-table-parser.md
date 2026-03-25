# Tool: markdown-table-parser

## Description

Bidirectional markdown table utility. Parses markdown tables into structured `ParsedTable` objects (headers, alignments, rows) and generates formatted markdown tables from array data with per-column alignment support (`left`, `center`, `right`, `none`).

## Status

**quarantine** - implemented and self-contained, pending integration review.

## API

```ts
import { parseTable, generateTable } from "./packages/tools/markdown-table-parser";

// Parse
const result = parseTable("| Name | Age |\n|------|-----|\n| Alice | 30 |");
// { headers: ["Name", "Age"], alignments: ["none", "none"], rows: [["Alice", "30"]] }

// Generate
const md = generateTable([["Alice", "30"], ["Bob", "25"]], ["Name", "Age"], ["left", "right"]);
```

## Integration Path

1. Wire into `packages/eight/tools.ts` as a registered agent tool.
2. Expose via CLI: `8gent table parse <file>` and `8gent table generate`.
3. Use in memory consolidation exports - memory entries can be dumped as markdown tables for human review.
4. Use in benchmark report generation (`benchmarks/autoresearch/`) to replace manual table formatting.

## Files

- `packages/tools/markdown-table-parser.ts` - implementation (~130 lines)
