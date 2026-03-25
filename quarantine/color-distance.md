# color-distance

**Tool name:** color-distance
**File:** `packages/tools/color-distance.ts`
**Status:** quarantine

## Description

Self-contained perceptual color distance calculator. Converts RGB to CIE Lab and computes delta E using CIE76 or simplified CIEDE2000. Includes nearest-color palette matching.

| Export | Purpose | Notes |
|--------|---------|-------|
| `rgbToLab(color)` | RGB-to-Lab conversion | sRGB linearization + D65 XYZ + Lab. |
| `deltaE(c1, c2, method)` | Color distance (RGB in) | Default method: CIE76. Accepts "CIEDE2000". |
| `deltaECIE76(lab1, lab2)` | CIE76 Euclidean distance | Fast. Less accurate near perceptual threshold. |
| `deltaECIEDE2000(lab1, lab2)` | Simplified CIEDE2000 | Hue rotation, chroma weighting, lightness comp. |
| `nearestColor(target, palette, method)` | Palette matcher | Returns closest color, index, and distance. |

## Integration Path

1. **Brand palette enforcement** - `packages/personality/` can use `nearestColor` to snap any generated color to the approved 8gent brand palette and reject hue violations (no purple, hue 270-350).
2. **TUI theme validation** - `apps/tui/src/theme/tokens.ts` validation pass can flag token values with deltaE > 5 from the approved semantic color set.
3. **Design systems DB** - `packages/design-systems/` can use `deltaE` to deduplicate color swatches when ingesting new design systems.
4. **Image tool** - `packages/tools/image.ts` can use `nearestColor` for palette quantization and dominant-color extraction workflows.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test surface

```ts
rgbToLab({ r: 255, g: 0, b: 0 })
// -> { L: ~53.2, a: ~80.1, b: ~67.2 }

deltaE({ r: 255, g: 0, b: 0 }, { r: 254, g: 0, b: 0 })
// -> ~0.3 (imperceptible)

deltaE({ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }, "CIEDE2000")
// -> large value (red vs blue)

nearestColor(
  { r: 232, g: 97, b: 10 },  // #E8610A brand orange
  [{ r: 255, g: 165, b: 0 }, { r: 255, g: 0, b: 0 }, { r: 232, g: 97, b: 10 }]
)
// -> { color: { r: 232, g: 97, b: 10 }, index: 2, distance: 0 }
```
