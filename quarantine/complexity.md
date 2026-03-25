# complexity-analyzer

Cyclomatic complexity analyzer for TypeScript/JavaScript functions.

## Location

`packages/validation/complexity-analyzer.ts`

## What it does

Scans all TS/JS files in the codebase and measures cyclomatic complexity of each function. Counts branching constructs (if, for, while, case, catch, ternary, logical operators, optional chaining, nullish coalescing).

1. **Flagged functions** - any function with complexity > threshold (default: 10)
2. **Most complex files** - ranked by total complexity across all functions
3. **Per-function scores** - every function gets a complexity number

## Usage

```bash
# Default scan from repo root, threshold 10
bun run packages/validation/complexity-analyzer.ts

# Custom threshold
bun run packages/validation/complexity-analyzer.ts --threshold 15

# JSON output
bun run packages/validation/complexity-analyzer.ts --json

# Specific directory
bun run packages/validation/complexity-analyzer.ts --root packages/validation
```

## Programmatic

```ts
import { analyzeComplexity } from "./packages/validation/complexity-analyzer.ts";

const report = analyzeComplexity("/path/to/repo", 10);
console.log(report.flagged);       // functions over threshold
console.log(report.files[0]);      // most complex file
```

## Quarantine reason

Standalone analysis tool. Not wired into the validation package index or any CI pipeline yet. Needs integration testing on larger codebases before promotion.

## Promotion criteria

- Wire into `packages/validation/index.ts` exports
- Add to pre-commit or CI as optional gate
- Validate accuracy against a known complexity benchmark
