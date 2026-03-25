/**
 * Color blending utility.
 * Implements Photoshop-compatible blend modes on RGB colors.
 * Includes gradient generation, lighten, and darken helpers.
 */

export interface RGBColor {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "dodge" | "burn";

/** Clamp a value to [0, 255]. */
function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Normalize 0-255 to 0-1. */
function n(v: number): number {
  return v / 255;
}

/** Denormalize 0-1 to 0-255. */
function d(v: number): number {
  return clamp(v * 255);
}

/** Apply a blend function channel-wise. */
function blendChannel(
  a: number,
  b: number,
  fn: (a: number, b: number) => number
): number {
  return d(fn(n(a), n(b)));
}

/** Blend two colors with a given mode and optional ratio (0-1, default 0.5). */
export function blend(
  color1: RGBColor,
  color2: RGBColor,
  ratio: number = 0.5,
  mode: BlendMode = "normal"
): RGBColor {
  const t = Math.max(0, Math.min(1, ratio));

  const modes: Record<BlendMode, (a: number, b: number) => number> = {
    normal: (a, b) => a * (1 - t) + b * t,
    multiply: (a, b) => a * b,
    screen: (a, b) => 1 - (1 - a) * (1 - b),
    overlay: (a, b) =>
      a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b),
    dodge: (a, b) => Math.min(1, a / (1 - b + 1e-9)),
    burn: (a, b) => Math.max(0, 1 - (1 - a) / (b + 1e-9)),
  };

  const fn = modes[mode];

  if (mode === "normal") {
    // ratio already encoded in fn for normal
    return {
      r: blendChannel(color1.r, color2.r, fn),
      g: blendChannel(color1.g, color2.g, fn),
      b: blendChannel(color1.b, color2.b, fn),
    };
  }

  // For non-normal modes: blend result with color1 using ratio
  const blended = {
    r: blendChannel(color1.r, color2.r, fn),
    g: blendChannel(color1.g, color2.g, fn),
    b: blendChannel(color1.b, color2.b, fn),
  };

  return {
    r: clamp(color1.r * (1 - t) + blended.r * t),
    g: clamp(color1.g * (1 - t) + blended.g * t),
    b: clamp(color1.b * (1 - t) + blended.b * t),
  };
}

/**
 * Generate a gradient between two colors.
 * @param color1 - start color
 * @param color2 - end color
 * @param steps - number of steps including start and end (min 2)
 * @returns array of RGBColor values from color1 to color2
 */
export function gradient(
  color1: RGBColor,
  color2: RGBColor,
  steps: number
): RGBColor[] {
  const count = Math.max(2, Math.round(steps));
  const result: RGBColor[] = [];

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    result.push({
      r: clamp(color1.r + (color2.r - color1.r) * t),
      g: clamp(color1.g + (color2.g - color1.g) * t),
      b: clamp(color1.b + (color2.b - color1.b) * t),
    });
  }

  return result;
}

/**
 * Lighten a color by an amount (0-1).
 * Blends toward white using screen-like expansion.
 * @param color - source RGB color
 * @param amount - 0 = no change, 1 = full white
 */
export function lighten(color: RGBColor, amount: number): RGBColor {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: clamp(color.r + (255 - color.r) * t),
    g: clamp(color.g + (255 - color.g) * t),
    b: clamp(color.b + (255 - color.b) * t),
  };
}

/**
 * Darken a color by an amount (0-1).
 * Blends toward black using multiplicative reduction.
 * @param color - source RGB color
 * @param amount - 0 = no change, 1 = full black
 */
export function darken(color: RGBColor, amount: number): RGBColor {
  const t = Math.max(0, Math.min(1, amount));
  const factor = 1 - t;
  return {
    r: clamp(color.r * factor),
    g: clamp(color.g * factor),
    b: clamp(color.b * factor),
  };
}

/**
 * Convert an RGB color to a hex string (#rrggbb).
 */
export function toHex(color: RGBColor): string {
  const hex = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

/**
 * Parse a hex string (#rrggbb or #rgb) to RGBColor.
 */
export function fromHex(hex: string): RGBColor {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}
