# color-contrast

WCAG 2.1 color contrast ratio calculator.

## Requirements
- contrast(hex1, hex2) returns ratio 1-21
- isAA(ratio, large?) checks WCAG AA threshold
- isAAA(ratio, large?) checks WCAG AAA threshold
- relativeLuminance(hex) returns 0-1 value
- suggestAccessible(fg, bg) returns adjusted fg that passes AA

## Status

Quarantine - pending review.

## Location

`packages/tools/color-contrast.ts`
