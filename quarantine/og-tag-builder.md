# og-tag-builder

Open Graph and Twitter Card tag builder with property validation and fallback generation.

## Requirements
- buildOG({ title, description, image, url, type?, siteName? }): OG properties object
- buildTwitterCard({ title, description, image, card? }): Twitter Card meta
- renderHTML(og, twitter): both tag sets as HTML strings
- validate(og): checks required OG properties and image dimensions hint
- preview(og): ASCII card preview of how share will look

## Status

Quarantine - pending review.

## Location

`packages/tools/og-tag-builder.ts`
