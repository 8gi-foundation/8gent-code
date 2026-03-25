# quarantine/md-renderer

**Status:** Quarantined - ready for review before promotion

## What it does

`packages/tools/md-renderer.ts` renders markdown to ANSI terminal output with zero external dependencies.

## Supported syntax

| Element | Markdown | ANSI output |
|---------|----------|-------------|
| H1 | `# Heading` | bold cyan + `=` underline |
| H2 | `## Heading` | bold yellow + `-` underline |
| H3-H6 | `### ...` | bold colored, indented |
| Bold | `**text**` | ANSI bold |
| Italic | `*text*` | ANSI italic |
| Bold+Italic | `***text***` | ANSI bold+italic |
| Inline code | `` `code` `` | green on black bg |
| Fenced code | ` ```lang ` | green body, dim lang label |
| Link | `[label](url)` | underline blue + dim url |
| Autolink | `<https://...>` | underline blue |
| Unordered list | `- item` | cyan bullet, nestable |
| Ordered list | `1. item` | yellow number, nestable |
| Horizontal rule | `---` | dim box-drawing line x60 |

## API

```ts
import { renderMarkdown } from './packages/tools/md-renderer.ts';

const ansi = renderMarkdown(markdownString);
process.stdout.write(ansi + '\n');
```

## Constraints

- Zero deps - pure string manipulation, no npm packages
- Terminal ANSI output only - no HTML
- No table rendering (v1 scope)
- No nested blockquotes (v1 scope)

## Promotion criteria

- [ ] Used in at least one screen (e.g. ChatScreen response rendering)
- [ ] Tested against real LLM output samples
- [ ] Table support added if needed
