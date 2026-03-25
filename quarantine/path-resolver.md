# path-resolver

**Tool name:** path-resolver
**Package:** `packages/tools/path-resolver.ts`
**Status:** quarantine

## Description

Resolves TypeScript path aliases and monorepo package references to absolute
file paths. Designed for agent code navigation, import analysis, and any tool
that needs to follow imports across a workspace without running the TypeScript
compiler.

### Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `resolveAlias` | `(importPath: string, tsconfigPath: string) => ResolveResult` | Reads `compilerOptions.paths` from a tsconfig (including `extends` one level deep), matches the import string against all aliases (including wildcard `@/*` patterns), and returns the absolute file path. |
| `resolvePackage` | `(name: string, rootDir: string) => ResolveResult` | Walks `packages/`, `apps/`, `libs/`, and `modules/` under `rootDir`, matches `package.json` by name, and resolves the entry point via `exports`, `main`, `module`, or index fallback. |

Both functions return `ResolveResult`:
```ts
{
  absolutePath: string | null;
  source: "alias" | "package" | "not-found";
  matchedAlias?: string;
}
```

## Integration path

1. Wire into `packages/ast-index/` as a resolution backend so the import
   dependency graph can follow aliased imports rather than stopping at the
   alias boundary.
2. Use in `packages/tools/import-sorter.ts` to validate that sorted imports
   actually resolve before writing changes back.
3. Expose as an agent tool in `packages/eight/tools.ts` under the name
   `resolve_import` so Eight can answer "which file does this import point to?"
   during code navigation sessions.

## Notes

- Zero external dependencies - uses only Node built-ins (`fs`, `path`).
- Strips single-line comments from tsconfig before parsing so it handles
  real-world tsconfig files without crashing.
- Does not support `paths` with multiple wildcard segments (rare in practice).
- `resolvePackage` searches one level deep from the repo root - sufficient
  for this monorepo layout.
