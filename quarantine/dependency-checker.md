# dependency-checker

**Status:** quarantine

## Description

Scans all TypeScript/JavaScript source files in a project and compares discovered imports against `package.json` to surface:

- **Unused dependencies** - declared in `package.json` but never imported anywhere in source
- **Missing dependencies** - imported in source but absent from `package.json`
- **Full declared dependency list** - all `dependencies`, `devDependencies`, and `peerDependencies` with versions

## API

```ts
import { checkDeps } from "./packages/tools/dependency-checker";

const report = checkDeps("/path/to/project");
// report.declared   - all declared deps with version and type
// report.unused     - subset of declared never found in source
// report.missing    - package names imported but not declared
// report.summary    - counts for quick inspection
```

## CLI

```bash
bun packages/tools/dependency-checker.ts [rootDir]
# defaults to cwd if rootDir omitted
```

## Integration Path

1. Wire into `packages/tools/index.ts` exports once validated against the 8gent-code repo itself.
2. Optionally expose as a slash command `/deps` in the TUI for on-demand project health checks.
3. Can feed into `packages/validation/` as a pre-session check to warn on missing deps before agent runs.

## Constraints

- Reads `package.json` at `rootDir` root only (no workspace-aware resolution yet).
- Uses regex-based import extraction - dynamic computed requires are not detected.
- Skips `node_modules`, `.git`, `dist`, `.8gent`, `coverage` directories.
