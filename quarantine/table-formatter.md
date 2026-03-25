# table-formatter

## Tool Name
`table-formatter`

## Description
Formats arrays of plain objects as aligned ASCII or Unicode tables for terminal display. Supports configurable column alignment (left, right, center), three border styles (none, ascii, unicode), per-column and global max-width truncation, and bold header styling.

## Status
**quarantine** - implemented, not yet wired into the main agent tool registry.

## Export
```ts
import { formatTable } from "../packages/tools/table-formatter";

const output = formatTable(data, {
  border: "unicode",       // "none" | "ascii" | "unicode"
  headerBold: true,
  columns: [
    { key: "name",  header: "Name",  align: "left",  maxWidth: 24 },
    { key: "score", header: "Score", align: "right", maxWidth: 8  },
  ],
});
console.log(output);
```

## Integration Path
1. Register in `packages/tools/index.ts` (or equivalent tool registry).
2. Wire into the agent's tool definitions in `packages/eight/tools.ts` as a display utility.
3. Use in memory health reports, benchmark dashboards, and any agent output that presents tabular data.
4. Optionally expose as a `/table` CLI command in the TUI.

## Files
- `packages/tools/table-formatter.ts` - single self-contained implementation (~140 lines)
