# Quarantine: Markdown Renderer

**Package:** `packages/tools/markdown-renderer.ts`
**Status:** Quarantined - not wired into any existing code
**Branch:** `quarantine/md-renderer`

## What it does

Renders markdown text to ANSI-colored terminal output. Zero dependencies - pure escape codes.

### Supported syntax

- **Headings** (h1-h6) - color-coded by level, bold
- **Bold** (`**text**`, `__text__`)
- **Italic** (`*text*`, `_text_`)
- **Bold+Italic** (`***text***`)
- **Strikethrough** (`~~text~~`)
- **Inline code** (`` `code` ``) - inverse background
- **Fenced code blocks** (``` ``` ```) - dimmed, with language label
- **Unordered lists** (`-`, `*`, `+`)
- **Ordered lists** (`1.`, `2.`)
- **Blockquotes** (`>`) - green pipe prefix
- **Links** (`[text](url)`) - underlined cyan text + dim URL
- **Horizontal rules** (`---`, `***`, `___`)

## Usage

```ts
import { renderMarkdown } from './packages/tools/markdown-renderer';
console.log(renderMarkdown('# Hello\n\nSome **bold** and *italic* text'));
```

### CLI pipe

```bash
cat README.md | bun run packages/tools/markdown-renderer.ts
```

## Why quarantined

New utility - needs validation before wiring into the TUI chat output or agent responses. Potential integration points:

- Chat message rendering in TUI
- `--help` output for tools that return markdown
- Agent response display

## Color mapping

| Element | ANSI style |
|---------|-----------|
| h1 | Red + Bold |
| h2 | Green + Bold |
| h3 | Yellow + Bold |
| h4 | Blue + Bold |
| h5 | Magenta + Bold |
| h6 | Cyan + Bold |
| Bold | Bold |
| Italic | Italic |
| Inline code | Inverse |
| Code block | Dim |
| Blockquote | Green |
| List bullet | Cyan |
| Link text | Underline + Cyan |
| Link URL | Dim |
| Horizontal rule | Dim line |
