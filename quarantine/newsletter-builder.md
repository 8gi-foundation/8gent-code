# newsletter-builder

Newsletter issue builder with sections, intro, featured content, and CTA blocks.

## Requirements
- createIssue({ number, date, subject, previewText })
- addSection(issue, { type, title, content, cta? })
- renderText(issue): plain-text newsletter format
- renderHTML(issue): HTML newsletter with inline styles
- wordCount(issue): total word count across all sections

## Status

Quarantine - pending review.

## Location

`packages/tools/newsletter-builder.ts`
