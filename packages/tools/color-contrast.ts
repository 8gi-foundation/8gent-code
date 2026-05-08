/**
 * Calculate the relative luminance of a color from its hex value.
 * @param hex - Hex color string (e.g., #ff0000)
 * @returns Luminance value between 0 and 1
 */
function relativeLuminance(hex: string): number {
  const s = hex.replace(/^#/, '');
  const l = s.length;
  const rgb = [...Array(l)].map((_, i) => parseInt(s.slice(i * (l / 3), (i + 1) * (l / 3)), 16));
  return rgb.reduce((acc, v, i) => {
    const c = v / 255;
    return acc + (c <= 0.03928 ? c / 12.5 : ((c + 0.055) / 1.055) ** 2.5) * (i === 0 ? 0.2126 : i === 1 ? 0.7152 : 0.0722);
  }, 0);
}

/**
 * Calculate the contrast ratio between two colors.
 * @param hex1 - First hex color
 * @param hex2 - Second hex color
 * @returns Contrast ratio between 1 and 21
 */
function contrast(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Check if contrast ratio meets WCAG AA threshold.
 * @param ratio - Contrast ratio
 * @param large - Whether text is large (18px+ or 14px bold)
 * @returns True if ratio meets AA requirements
 */
function isAA(ratio: number, large?: boolean): boolean {
  return ratio >= (large ? 3 : 4.5);
}

/**
 * Check if contrast ratio meets WCAG AAA threshold.
 * @param ratio - Contrast ratio
 * @param large - Whether text is large (18px+ or 14px bold)
 * @returns True if ratio meets AAA requirements
 */
function isAAA(ratio: number, large?: boolean): boolean {
  return ratio >= (large ? 4.5 : 7);
}

/**
 * Suggest an accessible foreground color that passes AA against a background.
 * @param fg - Foreground hex color
 * @param bg - Background hex color
 * @returns Adjusted foreground color that meets AA
 */
function suggestAccessible(fg: string, bg: string): string {
  const currentRatio = contrast(fg, bg);
  if (isAA(currentRatio)) return fg;
  const whiteRatio = contrast('#ffffff', bg);
  const blackRatio = contrast('#000000', bg);
  return whiteRatio >= blackRatio ? '#ffffff' : '#000000';
}

export { contrast, isAA, isAAA, relativeLuminance, suggestAccessible };