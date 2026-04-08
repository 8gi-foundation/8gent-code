/**
 * color-palette-gen.ts
 * Generate harmonious color palettes from a base hex color.
 * Supports: complementary, analogous, triadic, split-complementary, monochromatic.
 */

export type ColorScheme =
  | "complementary"
  | "analogous"
  | "triadic"
  | "split-complementary"
  | "monochromatic";

export interface HSL {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

export interface Palette {
  scheme: ColorScheme;
  base: string;
  colors: string[];
}

function hexToHsl(hex: string): HSL {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / delta + 2) / 6;
    else h = ((r - g) / delta + 4) / 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h: number, s: number, l: number): string {
  const hn = ((h % 360) + 360) % 360;
  const sn = Math.max(0, Math.min(100, s)) / 100;
  const ln = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;

  let r = 0, g = 0, b = 0;
  if (hn < 60)       { r = c; g = x; b = 0; }
  else if (hn < 120) { r = x; g = c; b = 0; }
  else if (hn < 180) { r = 0; g = c; b = x; }
  else if (hn < 240) { r = 0; g = x; b = c; }
  else if (hn < 300) { r = x; g = 0; b = c; }
  else               { r = c; g = 0; b = x; }

  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function buildHues(base: HSL, scheme: ColorScheme, count: number): number[] {
  const h = base.h;
  switch (scheme) {
    case "complementary":
      return distribute([h, h + 180], count);
    case "analogous":
      return distribute([h - 30, h, h + 30], count);
    case "triadic":
      return distribute([h, h + 120, h + 240], count);
    case "split-complementary":
      return distribute([h, h + 150, h + 210], count);
    case "monochromatic":
      return Array.from({ length: count }, (_, i) => h);
  }
}

/** Distribute `count` hues by cycling/interpolating from the anchor set. */
function distribute(anchors: number[], count: number): number[] {
  if (count <= anchors.length) return anchors.slice(0, count);
  const result: number[] = [...anchors];
  let i = 0;
  while (result.length < count) {
    result.push(anchors[i % anchors.length] + (i >= anchors.length ? 15 * Math.ceil(i / anchors.length) : 0));
    i++;
  }
  return result.slice(0, count);
}

function lightnessSteps(base: HSL, scheme: ColorScheme, count: number): number[] {
  if (scheme === "monochromatic") {
    // Spread lightness from dark to light around the base
    const step = 60 / Math.max(count - 1, 1);
    return Array.from({ length: count }, (_, i) => Math.max(10, Math.min(90, base.l - 30 + i * step)));
  }
  return Array.from({ length: count }, () => base.l);
}

/**
 * Generate a harmonious color palette from a base hex color.
 *
 * @param hex    - Base color as hex string (e.g. "#E8610A" or "E8610A")
 * @param scheme - Color harmony scheme
 * @param count  - Number of colors to return (default: 5)
 */
export function generatePalette(
  hex: string,
  scheme: ColorScheme,
  count = 5
): Palette {
  if (!/^#?[0-9A-Fa-f]{6}$/.test(hex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  if (count < 1 || count > 20) {
    throw new Error(`count must be between 1 and 20, got ${count}`);
  }

  const base = hexToHsl(hex.startsWith("#") ? hex : `#${hex}`);
  const hues = buildHues(base, scheme, count);
  const lightnesses = lightnessSteps(base, scheme, count);

  const colors = hues.map((h, i) =>
    hslToHex(h, base.s, lightnesses[i])
  );

  return {
    scheme,
    base: hex.startsWith("#") ? hex : `#${hex}`,
    colors,
  };
}

/** Adjust lightness of a hex color by a delta (-100 to +100). */
export function adjustLightness(hex: string, delta: number): string {
  const { h, s, l } = hexToHsl(hex.startsWith("#") ? hex : `#${hex}`);
  return hslToHex(h, s, l + delta);
}

/** Adjust saturation of a hex color by a delta (-100 to +100). */
export function adjustSaturation(hex: string, delta: number): string {
  const { h, s, l } = hexToHsl(hex.startsWith("#") ? hex : `#${hex}`);
  return hslToHex(h, s + delta, l);
}
