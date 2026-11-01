# path-matcher

**Tool name:** path-matcher
**File:** `packages/tools/path-matcher.ts`
**Status:** quarantine

## Description

Self-contained file path matcher with include/exclude pattern sets. Supports three pattern types resolved automatically from the input string.

| Export | Purpose |
|--------|---------|
| `PathMatcher` | Chainable class - call `.include()`, `.exclude()`, `.test()`, `.filter()` |
| `matchPath(path, include, exclude)` | One-shot convenience function |

### Pattern Types

| Type | Detection | Example |
|------|-----------|---------|
| **Glob** | Contains `*` or `?` | `src/**/*.ts`, `*.json`, `packages/*/index.ts` |
| **Exact** | Plain string, no wildcards | `src/index.ts` |
| **Regex** | Wrapped in `/pattern/flags` | `/\\.test\\.(ts|js)$/i` |

`**` matches across slashes. `*` matches within a single segment. `?` matches one non-slash character.

## Integration Path

1. **NemoClaw policy engine** - `packages/permissions/policy-engine.ts` can use `PathMatcher` for file-access allow/deny rules instead of inline regex.
2. **AST index** - `packages/ast-index/` can filter source files via include/exclude before building the dependency graph.
3. **Orchestration worktrees** - `packages/orchestration/` can scope delegated tasks to specific file sets.
4. **Benchmark harness** - `benchmarks/autoresearch/` can target specific file categories per benchmark run.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test Surface

```ts
const m = new PathMatcher()
  .include(["src/**/*.ts", "packages/**/*.ts"])
  .exclude(["**/*.test.ts", "**/*.spec.ts"]);

m.test("src/index.ts")              // true
m.test("src/utils/helper.test.ts")  // false - excluded
m.test("dist/index.js")             // false - not included

matchPath("src/index.ts", ["src/**"], ["**/*.test.ts"]) // true
matchPath("src/foo.test.ts", ["src/**"], ["**/*.test.ts"]) // false
```
