# color-blend

**Tool name:** color-blend
**File:** `packages/tools/color-blend.ts`
**Status:** quarantine

## Description

Self-contained color blending utility implementing Photoshop-compatible blend modes on RGB colors. Includes gradient generation, lighten/darken helpers, and hex parsing.

| Export | Purpose | Notes |
|--------|---------|-------|
| `blend(c1, c2, ratio, mode)` | Blend two colors | ratio 0-1, modes: normal, multiply, screen, overlay, dodge, burn |
| `gradient(c1, c2, steps)` | Linear gradient | Returns array of RGBColor from c1 to c2 |
| `lighten(color, amount)` | Lighten toward white | amount 0-1, blends toward #ffffff |
| `darken(color, amount)` | Darken toward black | amount 0-1, multiplies channels toward 0 |
| `toHex(color)` | RGBColor to #rrggbb | Zero-padded hex string |
| `fromHex(hex)` | #rrggbb or #rgb to RGBColor | Expands shorthand |

## Blend Modes

| Mode | Formula | Use |
|------|---------|-----|
| `normal` | linear interpolation by ratio | Standard mix |
| `multiply` | a * b | Darkens, preserves shadows |
| `screen` | 1 - (1-a)(1-b) | Brightens, preserves highlights |
| `overlay` | multiply if a<0.5, screen otherwise | Contrast boost |
| `dodge` | a / (1 - b) | Brighten highlights aggressively |
| `burn` | 1 - (1-a) / b | Darken shadows aggressively |

For non-normal modes, the ratio parameter controls how much of the blend effect is applied vs the original color1.

## Integration Path

1. **TUI theme tokens** - `apps/tui/src/theme/tokens.ts` can use `blend` and `gradient` to derive hover/active/disabled variants from a base brand color.
2. **Brand palette generation** - `packages/personality/` can use `gradient` to auto-generate tonal palettes from the #E8610A orange anchor.
3. **Design systems DB** - `packages/design-systems/` can use blend modes to preview how user-supplied colors interact with the 8gent palette before ingestion.
4. **Demo visuals** - `apps/demos/src/` scenes can use `gradient` and `lighten`/`darken` to generate smooth color transitions without adding a CSS library.

## Dependencies

None. Pure TypeScript, zero runtime dependencies.

## Test surface

```ts
import { blend, gradient, lighten, darken, fromHex, toHex } from "./color-blend";

const orange = fromHex("#E8610A");
const blue = fromHex("#0A61E8");

// Normal blend at 50%
blend(orange, blue, 0.5)
// -> ~{ r: 119, g: 97, b: 119 }

// Multiply mode at full intensity
blend(orange, blue, 1, "multiply")
// -> { r: 9, g: 22, b: 9 } (very dark - multiply darkens)

// Screen mode at full intensity
blend(orange, blue, 1, "screen")
// -> { r: 233, g: 155, b: 233 } (brightened)

// 5-step gradient
gradient(orange, blue, 5)
// -> [orange, ..., blue] with 5 steps

// Lighten 30%
toHex(lighten(orange, 0.3))
// -> "#ed8140"

// Darken 30%
toHex(darken(orange, 0.3))
// -> "#a24407"
```
