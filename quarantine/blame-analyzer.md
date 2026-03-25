# blame-analyzer

Git blame analysis tool that produces a codebase ownership report.

## Location

`packages/tools/blame-analyzer.ts`

## What it does

Runs `git blame --line-porcelain` across all tracked TS/JS files and outputs:

1. **Most-edited files** - ranked by unique commit count (proxy for churn)
2. **Code ownership** - lines per author with percentage
3. **Code age distribution** - lines bucketed by age (< 1 week, 1-4 weeks, 1-3 months, 3-6 months, 6-12 months, > 1 year)

## Usage

```bash
# JSON report for current repo
bun run packages/tools/blame-analyzer.ts

# Specify repo path
bun run packages/tools/blame-analyzer.ts /path/to/repo
```

## Programmatic

```ts
import { analyzeBlame } from "./packages/tools/blame-analyzer.ts";

const report = await analyzeBlame(".", 10); // top 10 most-edited
console.log(report.ownership);
```

## Output shape

```ts
interface BlameReport {
  totalFiles: number;
  totalLines: number;
  mostEdited: { path: string; commitCount: number }[];
  ownership: { author: string; lines: number; percentage: number }[];
  age: { label: string; lines: number; percentage: number }[];
  generatedAt: string;
}
```

## Quarantine status

- **Reason:** New tool, needs real-world testing on large repos
- **Graduation criteria:** Tested on 3+ repos, runtime under 30s for 500-file repos, report accuracy verified manually
- **Dependencies:** Bun shell (`$`), git CLI
