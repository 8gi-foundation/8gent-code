# escape-html

**Tool name:** escape-html
**File:** `packages/tools/escape-html.ts`
**Status:** quarantine

## Description

Context-aware string escaping for safe output in HTML, JavaScript, CSS, and URLs. Prevents XSS and injection attacks in any generated content that lands in a browser or templated document.

| Export | Purpose | Notes |
|--------|---------|-------|
| `escapeHtml(str)` | HTML text content escaping | Escapes &, <, >, ", ', ` |
| `escapeJs(str)` | JavaScript string literal escaping | Handles backslashes, quotes, newlines, Unicode line terminators |
| `escapeCss(str)` | CSS value/identifier escaping | Escapes non-word chars; Unicode via hex |
| `escapeUrl(str)` | URL component escaping | Wraps `encodeURIComponent` |
| `escapeAttribute(str)` | HTML attribute value escaping | Stricter than `escapeHtml` - also escapes `/` |
| `escapeForContext(str, context)` | Dispatcher | Routes to correct function by context string |

## Integration Path

1. **Browser tool** - `packages/tools/browser/` and `packages/tools/web.ts` can use `escapeForContext` when injecting user-supplied strings into fetched HTML or synthesized requests.
2. **Agent output rendering** - `apps/tui/` and `apps/demos/` can pipe any agent-generated content through `escapeHtml` before rendering in HTML views.
3. **Proactive package** - `packages/proactive/` generates HTML reports and email-style output; `escapeHtml` + `escapeAttribute` prevent injection in those artifacts.
4. **Kernel fine-tuning** - `packages/kernel/` builds prompt strings that embed code snippets; `escapeJs` can sanitize user-supplied snippets before embedding in eval contexts.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test surface

```ts
escapeHtml('<script>alert(1)</script>')
// => '&lt;script&gt;alert(1)&lt;/script&gt;'

escapeJs("line1\nline2")
// => 'line1\\nline2'

escapeCss('color: red; background: url(evil)')
// => 'color\: red\; background\: url\(evil\)'

escapeUrl('hello world & more')
// => 'hello%20world%20%26%20more'

escapeAttribute('" onload="evil()')
// => '&quot; onload=&quot;evil\(\)'

escapeForContext('<b>bold</b>', 'html')
// => '&lt;b&gt;bold&lt;/b&gt;'
```
