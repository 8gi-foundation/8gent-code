# glob-matcher

**Tool:** `packages/tools/glob-matcher.ts`
**Status:** quarantine
**Size:** ~95 lines, zero dependencies

## Description

Pure TypeScript glob pattern matching for file paths. Converts glob patterns to
regular expressions at runtime. Suitable for filtering file lists,
implementing .gitignore-style rules, or any path-matching inside the agent.

### Supported syntax

| Pattern | Meaning |
|---------|---------|
| `*` | Any characters except `/` |
| `**` | Any characters including `/` (recursive) |
| `?` | Any single character except `/` |
| `{a,b}` | Alternation - matches `a` or `b` |
| `!pattern` | Negation - excludes matching paths |

## Exported API

```typescript
globToRegex(pattern: string): RegExp
globMatch(pattern: string, path: string): boolean
globFilter(patterns: string | string[], paths: string[]): string[]
```

## Integration path

1. `packages/ast-index/` - filter source files by extension/directory glob.
2. `packages/permissions/policy-engine.ts` - path-based allow/deny rules.
3. `packages/orchestration/` - scoping delegated tasks to file subsets.
4. `packages/tools/browser/` - cache invalidation by path pattern.

Promote to `packages/tools/index.ts` re-export once one integration point is wired.
