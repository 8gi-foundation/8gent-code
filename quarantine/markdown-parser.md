# markdown-parser

Parse Markdown to an AST suitable for rendering or transformation.

## Requirements
- parse(md: string) -> Node[] AST
- Node types: heading, paragraph, code, blockquote, list, listItem, link, image, bold, italic, inlineCode, hr
- toString(nodes) serializes back to Markdown
- toPlainText(nodes) strips all markup
- Under 200 lines

## Status

Quarantine - pending review.

## Location

`packages/tools/markdown-parser.ts`
