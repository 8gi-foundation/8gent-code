# quarantine/table-fmt

## What

Terminal table renderer (`packages/tools/table-formatter.ts`) - ~90 lines.

## Capabilities

- Column alignment (left, center, right)
- Box-drawing borders (toggleable)
- Per-column ANSI color
- Automatic truncation with configurable ellipsis
- Responsive width - shrinks columns proportionally to fit terminal width
- Auto-sized columns based on content, or fixed widths

## API

```ts
import { renderTable } from "./packages/tools/table-formatter.ts";

const output = renderTable({
  columns: [
    { header: "Name", key: "name" },
    { header: "Score", key: "score", align: "right", color: "\x1b[32m" },
  ],
  rows: [
    { name: "alpha", score: 92 },
    { name: "beta", score: 87 },
  ],
  maxWidth: 60,
});

console.log(output);
```

## Status

Quarantined - needs integration test and wiring into agent tool output before promotion.

## Exit criteria

- [ ] Unit test covering alignment, truncation, border toggle, responsive shrink
- [ ] Wired into at least one agent tool that renders tabular data
- [ ] Reviewed for accessibility (no color-only semantics)
