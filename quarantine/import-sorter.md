# import-sorter

## Tool Name
`import-sorter`

## Description
Parses TypeScript source files and sorts import statements into four ordered groups:

1. **Node built-ins** - `node:fs`, `path`, `os`, and all other Node core modules
2. **External packages** - npm dependencies (`react`, `lodash`, `ai`, etc.)
3. **Internal aliases** - path-aliased imports starting with `@/`, `~/`, or `#/`
4. **Relative imports** - local file imports starting with `./` or `../`

Within each group, imports are sorted alphabetically by module path. A blank line is inserted between groups for readability.

## Export

```ts
import { sortImports, classifyImport } from "@8gent/tools/import-sorter";

const sorted = sortImports(sourceCode);
```

## Status
`quarantine`

The tool is functional and self-contained. It has not yet been wired into the agent tool registry or the TUI. Pending code review and integration decision.

## Integration Path

1. Register in `packages/eight/tools.ts` as an optional formatting tool
2. Expose via the CLI as `8gent format --imports <file>`
3. Optionally run automatically as a post-edit hook after agent file writes
4. Add unit tests under `packages/tools/__tests__/import-sorter.test.ts`

## Files
- `packages/tools/import-sorter.ts` - implementation (~140 lines)
