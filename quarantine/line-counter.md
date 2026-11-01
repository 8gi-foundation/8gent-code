# Quarantine: line-counter

## What

Self-contained lines-of-code counter with blank/comment detection, language identification from file extension, and project-level aggregation by language and directory. Supports TypeScript, JavaScript, Python, Go, and Rust comment styles (single-line and block).

## File

`packages/tools/line-counter.ts` (~118 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import { countLines, countProject } from './packages/tools/line-counter.ts';

// Single file
const stats = countLines('packages/eight/agent.ts');
// { code: 312, blank: 48, comment: 21, total: 381, language: "TypeScript", filePath: "..." }

// Entire project directory
const project = countProject('.', { ignore: ['vendor'] });
// project.totals     -> { code, blank, comment, total }
// project.byLanguage -> { TypeScript: {...}, Python: {...}, ... }
// project.byDirectory -> { "packages/eight": {...}, ... }
// project.files      -> LineStats[] for every file
```

## Supported languages

| Extension | Language |
|-----------|----------|
| `.ts`, `.tsx` | TypeScript |
| `.js`, `.jsx`, `.mjs` | JavaScript |
| `.py` | Python |
| `.go` | Go |
| `.rs` | Rust |

## Comment detection

| Language | Single-line | Block open | Block close |
|----------|-------------|------------|-------------|
| TypeScript/JS/Go/Rust | `//` | `/*` | `*/` |
| Python | `#` | `"""` | `"""` |

Block comments spanning multiple lines are tracked with an `inBlock` flag per file. Same-line open+close blocks (e.g. `/* inline */`) are correctly counted as one comment line.

## Default ignores

`node_modules`, `.git`, `dist`, `build`, `.8gent`

## Integration path

- [ ] Add exports to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: known fixture files with expected counts
- [ ] Wire into TUI as a `/stats` command or sidebar widget
- [ ] Consider CSV/JSON output mode for CI reporting
