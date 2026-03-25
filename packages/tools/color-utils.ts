/**
 * Color manipulation utilities for the 8gent design system.
 * Brand color: #E8610A
 */

export type RGB = { r: number; g: number; b: number };
export type HSL = { h: number; s: number; l: number };

/** Parse a hex color (#RRGGBB or #RGB) into RGB components (0-255). */
export function hexToRgb(hex: string): RGB {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3
    ? h.split("").map((c) => c + c).join("")
    : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Convert RGB (0-255) to HSL (h: 0-360, s/l: 0-100). */
export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: +(l * 100).toFixed(1) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: +(h * 360).toFixed(1), s: +(s * 100).toFixed(1), l: +(l * 100).toFixed(1) };
}

/** Convert HSL back to a hex string. */
function hslToHex({ h, s, l }: HSL): string {
  const sn = s / 100, ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * Math.max(0, Math.min(1, color)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Lighten a hex color by a percentage (0-100). */
export function lighten(hex: string, amount: number): string {
  const hsl = rgbToHsl(hexToRgb(hex));
  hsl.l = Math.min(100, hsl.l + amount);
  return hslToHex(hsl);
}

/** Darken a hex color by a percentage (0-100). */
export function darken(hex: string, amount: number): string {
  const hsl = rgbToHsl(hexToRgb(hex));
  hsl.l = Math.max(0, hsl.l - amount);
  return hslToHex(hsl);
}

/** Relative luminance of a hex color per WCAG 2.1. */
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two hex colors (1 to 21). */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return +((lighter + 0.05) / (darker + 0.05)).toFixed(2);
}

/** Check WCAG 2.1 accessibility. Level "AA" needs 4.5:1, "AAA" needs 7:1. */
export function isAccessible(
  fg: string,
  bg: string,
  level: "AA" | "AAA" = "AA",
): boolean {
  const ratio = contrastRatio(fg, bg);
  return level === "AAA" ? ratio >= 7 : ratio >= 4.5;
}

/** Generate a 5-stop palette from a brand hex color (darkest to lightest). */
export function generatePalette(brandHex: string): string[] {
  return [
    darken(brandHex, 30),
    darken(brandHex, 15),
    brandHex,
    lighten(brandHex, 20),
    lighten(brandHex, 40),
  ];
}

/** Pre-built palette from the 8gent brand orange #E8610A. */
export const BRAND_PALETTE = generatePalette("#E8610A");
