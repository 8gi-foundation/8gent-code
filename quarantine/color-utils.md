# Quarantine: color-utils

## What

`packages/tools/color-utils.ts` - pure color manipulation utilities (~90 lines).

## Functions

| Function | Purpose |
|----------|---------|
| `hexToRgb` | Parse #RRGGBB or #RGB to `{ r, g, b }` |
| `rgbToHsl` | Convert RGB to HSL (h 0-360, s/l 0-100) |
| `lighten` | Lighten a hex color by percentage |
| `darken` | Darken a hex color by percentage |
| `contrastRatio` | WCAG 2.1 contrast ratio between two hex colors |
| `isAccessible` | Check if fg/bg pair meets AA or AAA threshold |
| `generatePalette` | 5-stop palette from any brand hex (dark to light) |
| `BRAND_PALETTE` | Pre-built palette from #E8610A |

## Why quarantined

New utility package. Needs validation before wiring into the TUI theme system or design-systems DB. No existing files were modified.

## Graduation criteria

- Unit tests covering all functions
- Integration with TUI theme tokens (`apps/tui/src/theme/tokens.ts`)
- Verified against WCAG contrast checker for accuracy
- Reviewed for edge cases (short hex, out-of-range inputs)
