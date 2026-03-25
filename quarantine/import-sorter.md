# Quarantine: Import Sorter

**Package:** `packages/tools/import-sorter.ts`
**Status:** Quarantined - not wired into any existing code
**Lines:** ~90

## Problem (one sentence)

TypeScript files accumulate unsorted imports that mix external deps, internal packages, and relative paths with no consistent grouping.

## What it does

Exports `sortImports(source: string): string` which:

1. Preserves leading comments and preamble
2. Extracts the contiguous import block (handles multi-line imports)
3. Classifies each import as external, internal (`@8gent/`, `@/`), or relative (`./`, `../`)
4. Sorts alphabetically within each group
5. Joins groups with blank-line separators
6. Returns the full file with sorted imports

## What it does NOT do

- Modify any existing files or tool registrations
- Remove unused imports (that is a separate concern)
- Handle `require()` or dynamic `import()` calls
- Run as a CLI or hook - it is a pure function

## Success metric

Given a file with mixed imports, output has three sorted sections separated by blank lines: external first, internal second, relative third.

## Integration path (if promoted)

- Wire into `packages/tools/index.ts` as a tool callable by agents
- Optionally add as a pre-commit formatting step
