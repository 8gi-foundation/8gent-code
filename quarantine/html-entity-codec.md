# html-entity-codec

**Status:** quarantine

## Description

Self-contained HTML entity encoder/decoder for safe content rendering and XSS prevention.
Handles named entities, numeric decimal entities (`&#65;`), and numeric hex entities (`&#x41;`).
Provides three exports covering the three primary use cases: text content, attribute values, and decoding.

## Exports

| Function | Purpose |
|----------|---------|
| `encodeHTML(str)` | Encode special chars to HTML entities for text content |
| `decodeHTML(str)` | Decode named and numeric entities back to characters |
| `escapeForAttribute(str)` | Aggressive escape for use inside HTML attribute values |

## XSS Prevention

- `encodeHTML` neutralises `&`, `<`, `>`, `"`, `'`, `` ` ``, `/`, `=`
- `escapeForAttribute` additionally encodes tab, newline, and carriage return
- `decodeHTML` rejects null bytes, surrogates, and code points outside Unicode range

## Integration Path

1. **Wire into `packages/tools/index.ts`** - export alongside existing tools once out of quarantine
2. **Use in browser tool** (`packages/tools/browser/`) - sanitise scraped HTML before returning to agent
3. **Use in system prompt builder** (`packages/eight/prompts/system-prompt.ts`) - escape user-controlled strings before injecting into prompts
4. **Use in memory store** (`packages/memory/store.ts`) - encode stored content that will be rendered in TUI

## File

`packages/tools/html-entity-codec.ts` (~130 lines, zero dependencies)
