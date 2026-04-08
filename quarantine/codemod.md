# Quarantine: Codemod Runner

**Status:** Ready for review
**File:** `packages/tools/codemod.ts`
**Pattern:** Regex find/replace with glob filtering and dry-run mode

---

## What it does

`runCodemod()` applies regex-based find/replace transformations across a file tree. Built for bulk refactors - renaming symbols, enforcing style rules, migrating patterns.

- Regex find/replace with full capture group support ($1, $2, ...)
- Glob-based file filtering - target only the files that matter
- Dry-run mode - preview every match before writing anything
- 5 built-in codemods for common 8gent refactors (see below)
- Custom one-off codemods via CLI flags
- Zero deps: plain TypeScript + Node fs/promises

---

## API

```ts
import {
  runCodemod,
  dryRun,
  BUILT_IN_CODEMODS,
  type CodemodDef,
  type RunSummary,
} from "./packages/tools/codemod.ts";

// Run a built-in codemod
const summary = await runCodemod(BUILT_IN_CODEMODS["no-em-dashes"], {
  root: "./",
  dryRun: false,
});

// Dry-run preview only
const preview = await dryRun(BUILT_IN_CODEMODS["ink-safe-colors"], {
  root: "./apps/tui",
});

// Custom one-off codemod
const custom: CodemodDef = {
  name: "rename-provider",
  description: "Rename OllamaProvider to LocalProvider",
  find: /OllamaProvider/g,
  replace: "LocalProvider",
  glob: "**/*.{ts,tsx}",
  exclude: ["node_modules", "dist"],
};

const result = await runCodemod(custom, { root: "./packages" });
console.log(result.filesChanged, result.totalMatches);
```

---

## Built-in codemods

| Name | What it fixes |
|------|--------------|
| `ink-safe-colors` | Replace banned `color="gray/white/black"` props with `dimColor` |
| `no-em-dashes` | Replace em dashes (U+2014) with hyphens, project-wide |
| `console-to-debug` | Replace `console.log()` with `debug()` calls |
| `require-to-import` | Migrate `const x = require('y')` to ESM `import x from 'y'` |
| `localhost-to-env` | Replace hardcoded `http://localhost:PORT` with `process.env.API_URL` |
| `then-to-await` | Flag `.then().catch()` chains with a TODO comment |

---

## CLI usage

```bash
# List all codemods
bun packages/tools/codemod.ts --list

# Dry-run a named codemod
bun packages/tools/codemod.ts no-em-dashes --dry-run

# Run against a specific directory
bun packages/tools/codemod.ts ink-safe-colors --root ./apps/tui

# Custom one-off
bun packages/tools/codemod.ts --custom --find "OldName" --replace "NewName" --glob "**/*.ts" --dry-run

# Exclude additional paths
bun packages/tools/codemod.ts console-to-debug --exclude "**/*.test.ts" --exclude "scripts/"
```

---

## RunSummary shape

```ts
{
  codemod: string;        // codemod name
  filesScanned: number;   // total files matching glob
  filesChanged: number;   // files actually modified
  totalMatches: number;   // total regex matches across all files
  results: Array<{
    file: string;         // relative path
    matchCount: number;
    before: string;       // original content
    after: string;        // transformed content
    changed: boolean;
  }>;
  dryRun: boolean;
}
```

---

## Integration points

Pure utility - no wiring to existing files needed. Consumers import directly:

- Agent can call `runCodemod()` as a tool action during refactor tasks
- `packages/self-autonomy/` could use it during post-session mutation
- `packages/ast-index/` could suggest relevant codemods based on import graph changes

---

## What it is NOT

- Not an AST transformer (regex only - use ts-morph for AST-level changes)
- Not a parallel runner (sequential file processing, intentional for predictability)
- Not idempotent by design - running twice may produce different results if replacement matches the find pattern

---

## Checklist before promotion

- [ ] Unit tests: glob filtering, capture groups, dry-run no-writes, built-in codemods produce expected output
- [ ] Confirm regex lastIndex reset works correctly for global patterns across multiple files
- [ ] Wire `ink-safe-colors` into a pre-commit hook or lint check
- [ ] Add `--stats-only` flag for CI reporting (count matches without changing or printing content)
- [ ] Benchmark: scan time for full 8gent-code repo should be <2s
