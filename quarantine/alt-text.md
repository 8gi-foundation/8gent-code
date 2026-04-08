# alt-text

Generate descriptive alt text for images from metadata.

## Requirements
- altText(filename, context?) generates from filename heuristics
- isDecorative(alt) returns true for empty or purely decorative alt
- truncate(alt, maxLen) trims without cutting words
- normalizeFilename(name) strips extension and separators
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/alt-text.ts`
