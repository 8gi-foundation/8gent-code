# markdown-to-text

## Tool Name
`markdown-to-text`

## Description
Strips markdown formatting to produce clean plain text. Preserves all content (link text, image alt text, code content, list items, table cells) while removing markdown syntax. Handles headers, bold, italic, strikethrough, links, images, inline code, fenced code blocks, blockquotes, ordered and unordered lists, tables, horizontal rules, and HTML tags.

## Status
`quarantine`

Standalone utility - no external dependencies. Pure TypeScript string transformation via regex pipeline.

## Exports
- `mdToText(markdown: string, options?: MdToTextOptions): string`
- `MdToTextOptions` interface (`preserveNewlines`, `collapseBlankLines`, `trim`)

## Integration Path
1. Import directly in any package: `import { mdToText } from '../tools/markdown-to-text'`
2. Wire into `packages/tools/index.ts` when ready to promote
3. Candidate uses:
   - Voice output: strip markdown before sending to TTS (Ava, ElevenLabs)
   - Memory store: index plain text for FTS5 search instead of raw markdown
   - Notifications: clean text for Telegram messages
   - Browser tool: post-process fetched HTML-converted markdown
