# cli-link

Generate clickable hyperlinks in supported terminals.

## Requirements
- link(text, url) returns OSC 8 hyperlink escape sequence
- isSupported() checks TERM and CI env vars
- stripLinks(str) removes link escapes
- fallback(text, url) returns 'text (url)' for unsupported terminals
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/cli-link.ts`
