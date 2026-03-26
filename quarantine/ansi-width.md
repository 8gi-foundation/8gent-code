# ansi-width

Measure display width of strings containing ANSI codes.

## Requirements
- width(str) returns visible character count
- stripAnsi(str) removes escape codes
- pad(str, targetWidth, dir?) pads to width
- truncate(str, maxWidth) trims to display width
- Handles wide (CJK) characters as width 2

## Status

Quarantine - pending review.

## Location

`packages/tools/ansi-width.ts`
