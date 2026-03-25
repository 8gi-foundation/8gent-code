# Test Coverage Gap Report

Generated: 2026-03-25
Tool: `packages/validation/coverage-reporter.ts`

## Summary

| Metric | Value |
|--------|-------|
| Total source files (excl. index/types) | 245 |
| Files with corresponding test files | 0 |
| Overall test coverage | 0% |
| Packages scanned | 44 |
| Packages with any tests | 0 |

Zero packages in `packages/` have unit test files (`.test.ts` or `.spec.ts`) alongside their source files. Benchmark tests exist under `benchmarks/` but those are integration/harness tests, not unit tests for individual modules.

## Per-Package Breakdown

| Package | Source Files | Tested | Coverage |
|---------|-------------|--------|----------|
| ai | 7 | 0 | 0% |
| ast-index | 5 | 0 | 0% |
| auth | 7 | 0 | 0% |
| control-plane | 4 | 0 | 0% |
| daemon | 14 | 0 | 0% |
| db | 10 | 0 | 0% |
| design-agent | 3 | 0 | 0% |
| design-systems | 7 | 0 | 0% |
| eight | 17 | 0 | 0% |
| executor | 2 | 0 | 0% |
| harness-cli | 6 | 0 | 0% |
| hooks | 2 | 0 | 0% |
| kernel | 9 | 0 | 0% |
| memory | 20 | 0 | 0% |
| music | 6 | 0 | 0% |
| orchestration | 15 | 0 | 0% |
| permissions | 4 | 0 | 0% |
| personality | 3 | 0 | 0% |
| pet | 2 | 0 | 0% |
| planning | 2 | 0 | 0% |
| proactive | 13 | 0 | 0% |
| quarantine | 3 | 0 | 0% |
| reporting | 5 | 0 | 0% |
| self-autonomy | 10 | 0 | 0% |
| skills | 4 | 0 | 0% |
| specifications | 2 | 0 | 0% |
| telegram-bot | 9 | 0 | 0% |
| tools | 18 | 0 | 0% |
| toolshed | 11 | 0 | 0% |
| validation | 13 | 0 | 0% |
| voice | 8 | 0 | 0% |
| workflow | 4 | 0 | 0% |

Packages with only `index.ts`/`types.ts` (no testable source) are omitted: `dreams`, `i18n`, `infinite`, `lsp`, `mcp`, `planner`, `providers`, `registry`, `secrets`, `tasks`, `telegram`, `types`.

## Priority Recommendations

High-value targets for first test files, based on file count and criticality:

1. **memory** (20 files) - core persistence layer, data integrity matters
2. **tools** (18 files) - tool execution reliability
3. **eight** (17 files) - agent core loop
4. **orchestration** (15 files) - concurrent worktree management
5. **daemon** (14 files) - persistent service, needs regression safety
6. **validation** (13 files) - the testing infra itself should be tested
7. **proactive** (13 files) - autonomous actions need guardrails

## How to Run

```bash
# Text summary
bun run packages/validation/coverage-reporter.ts

# JSON output (for CI integration)
bun run packages/validation/coverage-reporter.ts --json
```
