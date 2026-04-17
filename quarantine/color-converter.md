# color-converter

## Tool Name
`color-converter`

## Description
Converts between hex, RGB, HSL, and ANSI 256 color formats for consistent terminal and UI color handling. Provides a single `parseColor()` entry point that accepts any supported format and normalizes to RGB, plus dedicated conversion functions for each format pair.

## Status
**quarantine** - standalone, no integration yet

## Exports
- `hexToRgb(hex: string): RGB | null` - parses #RGB or #RRGGBB
- `rgbToHsl(rgb: RGB): HSL` - converts RGB to hue/saturation/lightness
- `hslToRgb(hsl: HSL): RGB` - converts HSL back to RGB
- `toAnsi256(rgb: RGB): number` - maps RGB to nearest ANSI 256 index (16-255)
- `parseColor(input: string): ParsedColor` - parses hex, rgb(), hsl(), ansi256() strings

## Integration Path
1. Import into `apps/tui/src/theme/tokens.ts` to resolve hex brand tokens to ANSI 256 at runtime
2. Use in `packages/personality/` for consistent cross-environment color rendering
3. Wire into TUI theme provider so `color="cyan"` style rules can be validated against the brand palette
4. Potential use in `packages/design-systems/` registry for color format normalization

## Source
`packages/tools/color-converter.ts`
