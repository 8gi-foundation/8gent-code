# markdown-link-checker

**Tool:** `packages/tools/markdown-link-checker.ts`
**Status:** quarantine
**Size:** ~130 lines, zero dependencies

## Description

Extracts and validates all links from a markdown document. Handles inline
links, reference-style links, autolinks, and shortcut references. Classifies
each link by kind (http, relative, anchor) and checks relative links for file
existence on disk and anchor links against headings in the same document.

### Supported link syntax

| Form | Example |
|------|---------|
| Inline | `[text](href)` |
| Inline with title | `[text](href "title")` |
| Reference | `[text][id]` |
| Collapsed reference | `[text][]` |
| Shortcut reference | `[text]` |
| Autolink | `<https://example.com>` |

### Link kinds

| Kind | Check performed |
|------|----------------|
| `http` | Flagged as unchecked (no network fetch) |
| `relative` | Resolved against `basePath`, `existsSync` |
| `anchor` | Matched against GitHub-style heading slugs in the doc |

## Exported API

```typescript
extractLinks(md: string): Link[]
checkLinks(md: string, basePath: string): LinkCheckResult[]
brokenLinks(md: string, basePath: string): LinkCheckResult[]
```

`Link` carries `{ text, href, kind, line }`.
`LinkCheckResult` carries `{ link, ok, reason? }`.

## Integration path

1. `packages/validation/` - add a `checkMarkdownLinks()` step in the healing
   pipeline so broken doc links are caught before commit.
2. `packages/tools/index.ts` - re-export once at least one consumer is wired.
3. `packages/ast-index/` - cross-reference doc links against known symbol paths
   to detect stale API references in markdown files.
4. CI hook - run `brokenLinks()` over all `docs/*.md` files on PR open.

Promote to `packages/tools/index.ts` re-export once one integration point is wired.
