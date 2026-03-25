# duplicate-finder

**Package:** `packages/validation/duplicate-finder.ts`
**Status:** quarantine - review before merging to main

## What it does

1. Walks a directory tree (skips `node_modules`, `.git`, `dist`, `.8gent`, etc.)
2. SHA-256 hashes every file - groups files with identical hashes as duplicates
3. Sliding-window normalized code block comparison across `.ts/.tsx/.js/.jsx/.py/.go/.rs` files - finds repeated logic blocks of N lines or more
4. Reports wasted disk space from exact duplicates
5. Exports `findDuplicates()` for use by any agent or harness

## API

```ts
import { findDuplicates } from "./packages/validation/duplicate-finder";

const report = await findDuplicates("/path/to/repo", 6);
// report.duplicateGroups  - exact file duplicates, sorted by wasted bytes
// report.similarBlocks    - repeated code blocks across files
// report.totalWastedBytes - bytes wasted by exact duplicates
// report.scannedFiles     - total files walked
```

### DuplicateReport shape

```ts
{
  scannedFiles: number;
  duplicateGroups: Array<{
    hash: string;        // SHA-256 hex
    size: number;        // bytes per copy
    wastedBytes: number; // (copies - 1) * size
    files: string[];     // absolute paths
  }>;
  similarBlocks: Array<{
    snippet: string;     // first 3 lines of the block
    lineCount: number;   // window size used
    locations: Array<{ file: string; startLine: number }>;
  }>;
  totalWastedBytes: number;
  totalWastedMB: string;
}
```

## CLI

```bash
# Scan current directory
bun packages/validation/duplicate-finder.ts

# Scan a specific path
bun packages/validation/duplicate-finder.ts /path/to/scan

# JSON output (for piping to other tools)
bun packages/validation/duplicate-finder.ts --json

# Adjust minimum block size (default 6 lines)
bun packages/validation/duplicate-finder.ts --min-block-lines=10
```

## Constraints

- Zero external dependencies - uses only Node/Bun built-ins (`crypto`, `fs`, `path`)
- Does NOT modify any files - read-only scan
- Cap: at most 50 similar block groups and 20 duplicate file groups in human output
- Skipped dirs: `node_modules`, `.git`, `.8gent`, `dist`, `build`, `.turbo`, `coverage`, `__pycache__`, `.next`

## Known limitations

- Similar block detection is line-normalized but not AST-based - may produce false positives for short generic blocks
- Large repos may be slow on first run (no caching)
- Binary files are hashed but excluded from block analysis

## Integration path (after quarantine review)

Wire into `packages/validation/index.ts` and optionally call from `packages/self-autonomy/reflection.ts`.
