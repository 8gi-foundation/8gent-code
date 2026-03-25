# code-complexity

## Tool Name

`code-complexity`

## Description

Calculates cyclomatic and cognitive complexity scores for TypeScript functions. Parses source code to count decision branches, nesting depth, and structural breaks. Identifies refactoring candidates (hotspots) where complexity exceeds recommended thresholds.

- **Cyclomatic complexity:** counts decision points (if/else/for/while/case/catch/ternary/logical operators) + 1 base. Score > 10 signals refactor needed.
- **Cognitive complexity:** weights nesting depth on top of structural breaks. Score > 15 signals hard-to-read code.

## Status

`quarantine` - Not yet wired into the agent tool registry or any TUI/CLI surface. Needs evaluation before promotion.

## Integration Path

1. **Evaluate** - run against `packages/eight/agent.ts` and `packages/tools/` to validate scores match manual review.
2. **Register** - add to `packages/tools/index.ts` and wire into `packages/eight/tools.ts` as a `code_complexity` tool definition.
3. **Agent surface** - expose as a slash command or background analysis that flags high-complexity functions in the active file.
4. **Benchmark** - score the tool against known complex files before promoting to `stable`.

## Usage

```ts
import { analyzeComplexity } from "../packages/tools/code-complexity";
import { readFileSync } from "fs";

const code = readFileSync("packages/eight/agent.ts", "utf-8");
const result = analyzeComplexity(code);

console.log("Hotspots:", result.hotspots);
```

## Thresholds

| Metric | Warning | Refactor |
|--------|---------|---------|
| Cyclomatic | > 7 | > 10 |
| Cognitive | > 10 | > 15 |
| Nesting depth | > 3 | > 5 |
