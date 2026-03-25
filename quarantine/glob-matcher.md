# glob-matcher

**Tool:** `packages/tools/glob-matcher.ts`
**Status:** quarantine
**Size:** ~130 lines, zero dependencies

## Description

Pure TypeScript glob pattern matching for file paths. Converts glob patterns to regular expressions at runtime with no external dependencies. Suitable for filtering file lists, implementing `.gitignore`-style rules, or any path-matching need inside the agent.

### Supported syntax

| Pattern | Meaning |
|---------|---------|
| `*` | Any characters except `/` |
| `**` | Any characters including `/` (recursive) |
| `?` | Any single character except `/` |
| `{a,b}` | Alternation — matches `a` or `b` |
| `!pattern` | Negation — excludes matching paths |

## Exported API

```typescript
globToRegex(pattern: string): RegExp
globMatch(pattern: string, path: string): boolean
globFilter(patterns: string | string[], paths: string[]): string[]
```

## Integration path

1. **AST index** (`packages/ast-index/`) - filter source files by extension/directory glob.
2. **Permissions policy** (`packages/permissions/policy-engine.ts`) - path-based allow/deny rules.
3. **Worktree orchestration** (`packages/orchestration/`) - scoping delegated tasks to file subsets.
4. **Tool: browser file cache** (`packages/tools/browser/`) - cache invalidation by path pattern.

Promote to `packages/tools/index.ts` re-export once one of the above integration points is wired.
