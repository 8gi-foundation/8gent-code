# change-detector

## Description

Detects which files changed between git refs (or in the working tree) and maps them to affected test files and monorepo packages. Useful for selective test running in CI and for agent self-awareness about what a diff touches.

## Status

**quarantine** - standalone, not yet wired into any pipeline.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `detectChanges` | `(base?, head?) => ChangedFile[]` | Parse git diff into typed change records with category |
| `affectedTests` | `(changes) => string[]` | Map src files to sibling test files by convention |
| `affectedPackages` | `(changes, rootDir?) => string[]` | Identify which monorepo packages (apps/*, packages/*) contain changes |
| `detectChangeReport` | `(base?, head?, rootDir?) => ChangeReport` | Convenience wrapper returning all three above |

## Categories

Each changed file is tagged with one of: `src` | `test` | `config` | `docs` | `other`.

## Integration Path

1. Wire into CI (GitHub Actions) as a pre-step before `bun test` to scope test runs to affected packages only.
2. Expose as an agent tool in `packages/eight/tools.ts` so the agent can introspect a diff before deciding what to validate.
3. Feed into `packages/validation/` checkpoint-verify loop for targeted re-verification after self-modification.

## Usage

```ts
import { detectChangeReport } from "./packages/tools/change-detector.ts";

// Changed files since branching off main
const report = detectChangeReport("main", "HEAD");

console.log("Changed files:", report.files.length);
console.log("Affected tests:", report.affectedTestFiles);
console.log("Affected packages:", report.affectedPackageNames);
```

## Size

~140 lines. No external dependencies beyond Node/Bun stdlib (`child_process`, `fs`, `path`).
