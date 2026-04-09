# Quarantine: color-utils

**Status:** Ready for review
**File:** `packages/tools/color-utils.ts`
**Size:** ~190 lines, zero deps
**Branch:** `quarantine/color-utils`

---

## What It Does

Brand-aware color utilities for 8gent. Covers hex/RGB/HSL/ANSI conversion, brand enforcement (no purple hues 270-350), WCAG 2.1 contrast checking, and color scheme generation anchored to #E8610A.

---

## Exports

### `hexToRgb(hex: string): RGB`
Parses 3-digit or 6-digit hex (with or without `#`) to `{ r, g, b }`. Throws on invalid input.

### `rgbToHex(rgb: RGB): string`
Converts RGB back to uppercase 6-digit hex.

### `rgbToHsl(rgb: RGB): HSL`
Converts RGB to `{ h: 0-360, s: 0-100, l: 0-100 }`.

### `hslToRgb(hsl: HSL): RGB`
Converts HSL back to RGB.

### `rgbToAnsi(rgb: RGB): number`
Maps RGB to nearest ANSI 256-color code. Uses 216-color cube (16-231) and 24-step grayscale ramp (232-255).

### `validateBrand(color: string | RGB): BrandValidationResult`
Enforces the 8gent brand rule: no hues in 270-350 (purple/violet). Returns `{ valid, reason?, hue? }`.
Near-gray colors (saturation < 5%) pass unconditionally.

```ts
validateBrand("#E8610A") // { valid: true, hue: 22.5 }
validateBrand("#8B5CF6") // { valid: false, hue: 263.4, reason: "..." }
```

### `contrastRatio(a: string | RGB, b: string | RGB): number`
WCAG 2.1 contrast ratio (1-21). Accepts hex strings or RGB objects.

### `wcagLevel(fg, bg, largeText?): { ratio, AA, AAA }`
Returns ratio plus AA/AAA pass/fail flags.

| Text size | AA    | AAA   |
|-----------|-------|-------|
| Normal    | >=4.5 | >=7.0 |
| Large     | >=3.0 | >=4.5 |

### `relativeLuminance(rgb: RGB): number`
Raw WCAG 2.1 relative luminance (0-1).

### `generateScheme(baseHex?: string): ColorScheme`
Generates scheme from `#E8610A` (or any hex): `brand`, `complementary`, `analogous[2]`, `triadic[2]`, `tints[5]`, `shades[5]`. All output hues nudged outside the 270-350 forbidden range automatically.

---

## Integration Points

- `apps/tui/src/theme/tokens.ts` - validate token colors at build time with `validateBrand()`
- `packages/design-systems/` - use `generateScheme()` for palette generation
- Any new UI component - run `validateBrand()` on color props before shipping

---

## What It Is NOT

- Not a CSS-in-JS engine
- No alpha/opacity support
- No color-name lookups (hex/RGB only)

---

## Suggested Tests

- `hexToRgb` round-trip: 3-digit and 6-digit inputs
- `rgbToHsl` / `hslToRgb` round-trip
- `validateBrand` rejects hues 270-350, passes all others
- `validateBrand` passes near-gray regardless of hue
- `contrastRatio("#000000", "#FFFFFF")` === 21
- `generateScheme()` - no output color fails `validateBrand()`

---

## Promotion Checklist

- [ ] Unit tests written and passing
- [ ] Integrated into at least one call site (TUI tokens or demo)
- [ ] `validateBrand` run against all existing theme tokens with no violations
- [ ] PR reviewed
- [ ] CHANGELOG.md updated
