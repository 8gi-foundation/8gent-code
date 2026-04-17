# svg-sanitize

Strip unsafe elements and attributes from SVG strings.

## Requirements
- sanitize(svg) removes script, foreignObject, and event handlers
- removeScripts(svg) strips <script> tags
- removeHandlers(svg) strips on* attributes
- isClean(svg) returns boolean
- Zero dependencies, regex-based (safe for simple SVGs)

## Status

Quarantine - pending review.

## Location

`packages/tools/svg-sanitize.ts`
