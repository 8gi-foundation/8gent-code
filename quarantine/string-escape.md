# string-escape

**Status:** Quarantine - awaiting review
**File:** `packages/tools/string-escape.ts`
**Lines:** ~140

## What it does

Escapes strings for safe use in specific output contexts: regex patterns, HTML,
XML, JSON string literals, POSIX shell arguments, and SQL string values. Includes
unescape counterparts for HTML and JSON.

## API

```ts
import {
  escapeRegex,
  escapeHtml, unescapeHtml,
  escapeXml,
  escapeJson, unescapeJson,
  escapeShell,
  escapeSql,
} from './packages/tools/string-escape';

escapeRegex('1+1=2 (maybe)');    // '1\\+1=2 \\(maybe\\)'
escapeHtml('<b>Hello & "world"</b>');  // '&lt;b&gt;Hello &amp; &quot;world&quot;&lt;/b&gt;'
unescapeHtml('&lt;p&gt;');        // '<p>'
escapeXml("O'Reilly & Sons");     // "O&apos;Reilly &amp; Sons"
escapeJson('line1\nline2');       // 'line1\\nline2'
unescapeJson('line1\\nline2');    // 'line1\nline2'
escapeShell("it's alive");        // "'it'\\''s alive'"
escapeSql("it's a trap");         // "it''s a trap"
```

## Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `escapeRegex` | `(str: string) => string` | Escapes all regex metacharacters |
| `escapeHtml` | `(str: string) => string` | Escapes `& < > " '` as HTML entities |
| `unescapeHtml` | `(str: string) => string` | Reverses common HTML entities |
| `escapeXml` | `(str: string) => string` | Escapes five XML predefined entities, strips illegal chars |
| `escapeJson` | `(str: string) => string` | Escapes for JSON string literal embedding |
| `unescapeJson` | `(str: string) => string` | Reverses JSON escape sequences |
| `escapeShell` | `(str: string) => string` | POSIX single-quote wrapping with `'\''` trick |
| `escapeSql` | `(str: string) => string` | Doubles single quotes for ANSI SQL literals |

## Why quarantine?

No external dependencies. Covers the most common injection-risk contexts in one
place. Needs review before wiring into `packages/tools/index.ts`. Potential use
in the browser tool (HTML scraping), shell tool (command construction), and memory
store (SQL query building).

## Acceptance criteria

- [ ] Reviewed by James
- [ ] Add to `packages/tools/index.ts` exports
- [ ] Consider adding `escapeShellArg` variant for Windows `cmd.exe` / PowerShell
- [ ] Verify `escapeSql` dialect coverage is sufficient or add dialect param
