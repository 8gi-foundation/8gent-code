/**
 * color-converter.ts
 *
 * Converts between hex, RGB, HSL, and ANSI 256 color formats.
 * Self-contained - no external dependencies.
 */

export interface RGB {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

export interface HSL {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

export interface ParsedColor {
  format: "hex" | "rgb" | "hsl" | "ansi256" | "unknown";
  rgb: RGB | null;
}

/**
 * Convert a hex color string to RGB.
 * Supports #RGB, #RRGGBB (with or without leading #).
 */
export function hexToRgb(hex: string): RGB | null {
  const cleaned = hex.replace(/^#/, "");

  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r, g, b };
  }

  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return { r, g, b };
  }

  return null;
}

/**
 * Convert RGB to HSL.
 */
export function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));

    switch (max) {
      case r:
        h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / delta + 2) / 6;
        break;
      case b:
        h = ((r - g) / delta + 4) / 6;
        break;
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

/**
 * Convert HSL back to RGB.
 */
export function hslToRgb(hsl: HSL): RGB {
  const h = hsl.h / 360;
  const s = hsl.s / 100;
  const l = hsl.l / 100;

  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }

  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

/**
 * Map an RGB value to the nearest ANSI 256 color code.
 * Uses the 6x6x6 color cube (indices 16-231) and grayscale ramp (232-255).
 */
export function toAnsi256(rgb: RGB): number {
  const { r, g, b } = rgb;

  // Check if it maps cleanly to the grayscale ramp (232-255)
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }

  // Map to the 6x6x6 color cube
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);

  return 16 + 36 * ri + 6 * gi + bi;
}

/**
 * Parse a CSS-style color string into a normalized RGB value.
 * Supports: #hex, rgb(...), hsl(...), ansi256(...).
 */
export function parseColor(input: string): ParsedColor {
  const s = input.trim().toLowerCase();

  // Hex
  if (s.startsWith("#")) {
    const rgb = hexToRgb(s);
    return { format: "hex", rgb };
  }

  // rgb(r, g, b)
  const rgbMatch = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    const rgb: RGB = {
      r: parseInt(rgbMatch[1]),
      g: parseInt(rgbMatch[2]),
      b: parseInt(rgbMatch[3]),
    };
    return { format: "rgb", rgb };
  }

  // hsl(h, s%, l%)
  const hslMatch = s.match(/^hsl\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*\)$/);
  if (hslMatch) {
    const hsl: HSL = {
      h: parseInt(hslMatch[1]),
      s: parseInt(hslMatch[2]),
      l: parseInt(hslMatch[3]),
    };
    const rgb = hslToRgb(hsl);
    return { format: "hsl", rgb };
  }

  // ansi256(n)
  const ansiMatch = s.match(/^ansi256\(\s*(\d+)\s*\)$/);
  if (ansiMatch) {
    const idx = parseInt(ansiMatch[1]);
    // Approximate reverse: map cube index back to RGB
    if (idx >= 232 && idx <= 255) {
      const v = Math.round((idx - 232) / 24 * 247 + 8);
      return { format: "ansi256", rgb: { r: v, g: v, b: v } };
    }
    if (idx >= 16 && idx <= 231) {
      const n = idx - 16;
      const ri = Math.floor(n / 36);
      const gi = Math.floor((n % 36) / 6);
      const bi = n % 6;
      return {
        format: "ansi256",
        rgb: {
          r: Math.round(ri / 5 * 255),
          g: Math.round(gi / 5 * 255),
          b: Math.round(bi / 5 * 255),
        },
      };
    }
    return { format: "ansi256", rgb: null };
  }

  return { format: "unknown", rgb: null };
}
