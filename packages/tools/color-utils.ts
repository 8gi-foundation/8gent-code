/**
 * color-utils.ts - Brand-aware color utilities for 8gent. Zero deps.
 *
 * Exports: hexToRgb, rgbToHex, rgbToHsl, hslToRgb, rgbToAnsi,
 *          validateBrand, contrastRatio, wcagLevel, relativeLuminance, generateScheme
 */

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }
export interface BrandValidationResult { valid: boolean; reason?: string; hue?: number }
export interface ColorScheme {
  brand: string;
  complementary: string;
  analogous: [string, string];
  triadic: [string, string];
  tints: string[];
  shades: string[];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function colorDistance(a: RGB, b: RGB): number {
  return Math.pow(a.r - b.r, 2) + Math.pow(a.g - b.g, 2) + Math.pow(a.b - b.b, 2);
}

// ---------------------------------------------------------------------------
// Hex / RGB / HSL conversions
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): RGB {
  const clean = hex.replace(/^#/, "");
  let full: string;
  if (clean.length === 3) full = clean.split("").map((c) => c + c).join("");
  else if (clean.length === 6) full = clean;
  else throw new Error(`Invalid hex color: "${hex}"`);
  const value = parseInt(full, 16);
  if (Number.isNaN(value)) throw new Error(`Invalid hex color: "${hex}"`);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export function rgbToHex(rgb: RGB): string {
  const toHex = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
}

export function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = ((h * 60) + 360) % 360;
  }
  return {
    h: Math.round(h * 10) / 10,
    s: Math.round(s * 1000) / 10,
    l: Math.round(l * 1000) / 10,
  };
}

export function hslToRgb(hsl: HSL): RGB {
  const h = hsl.h / 360, s = hsl.s / 100, l = hsl.l / 100;
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = ((t % 1) + 1) % 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

// ---------------------------------------------------------------------------
// ANSI 256-color mapping
// ---------------------------------------------------------------------------

export function rgbToAnsi(rgb: RGB): number {
  const { r, g, b } = rgb;
  const gray = Math.round((r * 0.299 + g * 0.587 + b * 0.114 - 8) / 247 * 24);
  const grayCode = 232 + clamp(gray, 0, 23);
  const cubeSteps = [0, 95, 135, 175, 215, 255];
  const snap = (n: number) => {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < cubeSteps.length; i++) {
      const d = Math.abs(n - cubeSteps[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };
  const ri = snap(r), gi = snap(g), bi = snap(b);
  const cubeCode = 16 + 36 * ri + 6 * gi + bi;
  const cubeDist = colorDistance({ r: cubeSteps[ri], g: cubeSteps[gi], b: cubeSteps[bi] }, rgb);
  const gv = 8 + 10 * clamp(gray, 0, 23);
  return colorDistance({ r: gv, g: gv, b: gv }, rgb) < cubeDist ? grayCode : cubeCode;
}

// ---------------------------------------------------------------------------
// Brand validation (no purple/violet hues 270-350)
// ---------------------------------------------------------------------------

const FORBIDDEN_HUE_MIN = 270;
const FORBIDDEN_HUE_MAX = 350;

export function validateBrand(color: string | RGB): BrandValidationResult {
  let rgb: RGB;
  try { rgb = typeof color === "string" ? hexToRgb(color) : color; }
  catch (e) { return { valid: false, reason: `Could not parse color: ${(e as Error).message}` }; }
  const hsl = rgbToHsl(rgb);
  // Near-gray has no meaningful hue - allow it
  if (hsl.s < 5) return { valid: true, hue: hsl.h };
  if (hsl.h >= FORBIDDEN_HUE_MIN && hsl.h <= FORBIDDEN_HUE_MAX) {
    return {
      valid: false,
      hue: hsl.h,
      reason: `Hue ${hsl.h.toFixed(1)} is in the forbidden purple/violet range (270-350). 8gent brand prohibits this.`,
    };
  }
  return { valid: true, hue: hsl.h };
}

// ---------------------------------------------------------------------------
// WCAG 2.1 contrast
// ---------------------------------------------------------------------------

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(rgb: RGB): number {
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

export function contrastRatio(a: string | RGB, b: string | RGB): number {
  const rgbA = typeof a === "string" ? hexToRgb(a) : a;
  const rgbB = typeof b === "string" ? hexToRgb(b) : b;
  const lumA = relativeLuminance(rgbA), lumB = relativeLuminance(rgbB);
  return (Math.max(lumA, lumB) + 0.05) / (Math.min(lumA, lumB) + 0.05);
}

export function wcagLevel(
  fg: string | RGB,
  bg: string | RGB,
  largeText = false
): { ratio: number; AA: boolean; AAA: boolean } {
  const ratio = contrastRatio(fg, bg);
  return {
    ratio: Math.round(ratio * 100) / 100,
    AA: ratio >= (largeText ? 3.0 : 4.5),
    AAA: ratio >= (largeText ? 4.5 : 7.0),
  };
}

// ---------------------------------------------------------------------------
// Color scheme generation anchored to #E8610A
// ---------------------------------------------------------------------------

const BRAND_HEX = "#E8610A";

export function generateScheme(baseHex: string = BRAND_HEX): ColorScheme {
  const rgb = hexToRgb(baseHex);
  const hsl = rgbToHsl(rgb);
  const safeHue = (h: number) => {
    let hh = ((h % 360) + 360) % 360;
    if (hh >= FORBIDDEN_HUE_MIN && hh <= FORBIDDEN_HUE_MAX) {
      hh = hh < (FORBIDDEN_HUE_MIN + FORBIDDEN_HUE_MAX) / 2
        ? FORBIDDEN_HUE_MIN - 10
        : FORBIDDEN_HUE_MAX + 10;
      hh = ((hh % 360) + 360) % 360;
    }
    return hh;
  };
  const fromHue = (h: number, s = hsl.s, l = hsl.l) =>
    rgbToHex(hslToRgb({ h: safeHue(h), s, l }));
  const tints = Array.from({ length: 5 }, (_, i) =>
    fromHue(hsl.h, hsl.s, clamp(hsl.l + (i + 1) * ((90 - hsl.l) / 6), hsl.l, 95)));
  const shades = Array.from({ length: 5 }, (_, i) =>
    fromHue(hsl.h, hsl.s, clamp(hsl.l - (i + 1) * ((hsl.l - 5) / 6), 5, hsl.l)));
  return {
    brand: rgbToHex(rgb),
    complementary: fromHue(hsl.h + 180),
    analogous: [fromHue(hsl.h - 30), fromHue(hsl.h + 30)],
    triadic: [fromHue(hsl.h + 120), fromHue(hsl.h + 240)],
    tints,
    shades,
  };
}
