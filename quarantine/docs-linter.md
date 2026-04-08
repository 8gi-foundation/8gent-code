# Quarantine: docs-linter

## What it does

`packages/validation/docs-linter.ts` lints markdown documentation files with 5 rules:

| Rule | What it checks |
|------|---------------|
| `no-em-dash` | Em dashes (U+2014) are banned per CLAUDE.md |
| `missing-h1` | Every doc should have a top-level H1 heading |
| `heading-hierarchy` | Headings must not skip levels (e.g. H1 to H3) |
| `broken-link` | Relative internal links must resolve to existing files |
| `unclosed-code-block` | Code fences must be properly closed |

## Usage

```bash
bun run packages/validation/docs-linter.ts docs/MEMORY-SPEC.md CLAUDE.md
```

Returns exit code 0 if clean, 1 if issues found.

## Programmatic API

```ts
import { lintMarkdown, lintFiles } from "./packages/validation/docs-linter.ts";

const issues = lintMarkdown("docs/README.md");
// or
const allIssues = lintFiles(["docs/A.md", "docs/B.md"]);
```

## Size

~110 lines. Zero external dependencies beyond Node/Bun built-ins.

## Graduation criteria

- Wire into CI as a pre-commit or PR check
- Add glob-based discovery (lint all `**/*.md` automatically)
- Add configurable rule severity (warn vs error)

## Status

Quarantined. Not wired into any existing pipeline yet.
