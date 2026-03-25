# color-palette-gen

**Status:** quarantine

## Description

Generates harmonious color palettes from a base hex color. Supports five classic color harmony schemes: complementary, analogous, triadic, split-complementary, and monochromatic. Includes utilities for adjusting lightness and saturation independently.

Useful for UI theming, design-token generation, and any agent task that needs to propose visually coherent color sets from a brand color.

## Exports

- `generatePalette(hex, scheme, count?)` - returns a `Palette` with `base`, `scheme`, and `colors` array of hex strings
- `adjustLightness(hex, delta)` - shift lightness by a delta value (-100 to +100)
- `adjustSaturation(hex, delta)` - shift saturation by a delta value (-100 to +100)
- `ColorScheme` - union type of all supported scheme names
- `HSL` / `Palette` - TypeScript interfaces for color data

## Integration Path

1. Wire into `packages/eight/tools.ts` as a `color_palette` tool: accepts `{ hex, scheme, count }`, returns the `Palette` object.
2. Use inside the TUI theme system (`apps/tui/src/theme/tokens.ts`) to let agents propose token sets from the brand color `#E8610A`.
3. Expose via the design-systems package (`packages/design-systems/`) as a palette-generation utility for stored design systems.
4. Surface in the CLUI settings panel so users can preview generated palettes before applying them.

## Location

`packages/tools/color-palette-gen.ts`

## Notes

- All conversions are pure HSL math - no external dependencies.
- `count` defaults to 5, max 20.
- Monochromatic scheme spreads lightness across the count rather than hue.
- Input hex must be 6-digit (with or without leading `#`).
