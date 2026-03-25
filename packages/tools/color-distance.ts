/**
 * Perceptual color distance calculator.
 * Implements CIE76 and simplified CIEDE2000 delta E formulas.
 * Includes RGB-to-Lab conversion and nearest-color palette matching.
 */

export interface RGBColor {
  r: number; // 0-255
  g: number; // 0-255
  b: number; // 0-255
}

export interface LabColor {
  L: number;
  a: number;
  b: number;
}

/** Convert sRGB (0-255) to CIE Lab via XYZ D65. */
export function rgbToLab(color: RGBColor): LabColor {
  // Linearize sRGB
  const linearize = (v: number): number => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };

  const r = linearize(color.r);
  const g = linearize(color.g);
  const b = linearize(color.b);

  // sRGB -> XYZ (D65 illuminant)
  const X = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

  // Normalize by D65 reference white
  const xn = X / 0.95047;
  const yn = Y / 1.00000;
  const zn = Z / 1.08883;

  const f = (t: number): number =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;

  const fx = f(xn);
  const fy = f(yn);
  const fz = f(zn);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/**
 * CIE76 delta E - simple Euclidean distance in Lab space.
 * Fast. Good for large distances. Less accurate for near-threshold pairs.
 */
export function deltaECIE76(lab1: LabColor, lab2: LabColor): number {
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Simplified CIEDE2000 delta E.
 * Accounts for hue rotation, chroma weighting, and lightness compensation.
 * More perceptually uniform than CIE76 for near-threshold discrimination.
 */
export function deltaECIEDE2000(lab1: LabColor, lab2: LabColor): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7

  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  const h1p = Math.atan2(b1, a1p) * (180 / Math.PI) + (b1 < 0 || a1p < 0 ? 360 : 0);
  const h2p = Math.atan2(b2, a2p) * (180 / Math.PI) + (b2 < 0 || a2p < 0 ? 360 : 0);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else if (h2p - h1p > 180) {
    dhp = h2p - h1p - 360;
  } else {
    dhp = h2p - h1p + 360;
  }

  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let Hbarp: number;
  if (C1p * C2p === 0) {
    Hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    Hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    Hbarp = (h1p + h2p + 360) / 2;
  } else {
    Hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos(((Hbarp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * Hbarp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * Hbarp + 6) * Math.PI) / 180) -
    0.20 * Math.cos(((4 * Hbarp - 63) * Math.PI) / 180);

  const SL = 1 + 0.015 * Math.pow(Lbarp - 50, 2) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;

  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const dTheta = 30 * Math.exp(-Math.pow((Hbarp - 275) / 25, 2));
  const RT = -Math.sin((2 * dTheta * Math.PI) / 180) * RC;

  return Math.sqrt(
    Math.pow(dLp / SL, 2) +
      Math.pow(dCp / SC, 2) +
      Math.pow(dHp / SH, 2) +
      RT * (dCp / SC) * (dHp / SH)
  );
}

export type DeltaEMethod = "CIE76" | "CIEDE2000";

/**
 * Calculate perceptual distance between two RGB colors.
 * @param color1 - first RGB color
 * @param color2 - second RGB color
 * @param method - "CIE76" (default) or "CIEDE2000"
 */
export function deltaE(
  color1: RGBColor,
  color2: RGBColor,
  method: DeltaEMethod = "CIE76"
): number {
  const lab1 = rgbToLab(color1);
  const lab2 = rgbToLab(color2);
  return method === "CIEDE2000"
    ? deltaECIEDE2000(lab1, lab2)
    : deltaECIE76(lab1, lab2);
}

/**
 * Find the nearest color in a palette to the target color.
 * @param target - RGB color to match
 * @param palette - array of RGB colors to search
 * @param method - distance formula to use
 * @returns the closest palette color and its index
 */
export function nearestColor(
  target: RGBColor,
  palette: RGBColor[],
  method: DeltaEMethod = "CIEDE2000"
): { color: RGBColor; index: number; distance: number } {
  if (palette.length === 0) throw new Error("Palette must not be empty");

  const targetLab = rgbToLab(target);
  let bestIndex = 0;
  let bestDist = Infinity;

  for (let i = 0; i < palette.length; i++) {
    const lab = rgbToLab(palette[i]);
    const dist =
      method === "CIEDE2000"
        ? deltaECIEDE2000(targetLab, lab)
        : deltaECIE76(targetLab, lab);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = i;
    }
  }

  return { color: palette[bestIndex], index: bestIndex, distance: bestDist };
}
