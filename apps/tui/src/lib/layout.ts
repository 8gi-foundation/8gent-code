/**
 * Layout math helpers for terminal UI.
 * Pure functions, no dependencies on React or Ink.
 */

/** Clamp a value between min and max (inclusive). */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Calculate the width of each column given total width, number of columns,
 * and optional gap between columns. Returns at least 0.
 */
export function columnWidth(
  totalWidth: number,
  columns: number,
  gap: number = 0,
): number {
  if (columns <= 0) return 0;
  if (columns === 1) return Math.max(0, totalWidth);
  const totalGap = gap * (columns - 1);
  return Math.max(0, Math.floor((totalWidth - totalGap) / columns));
}

/**
 * Determine how many columns fit given the available width,
 * a minimum item width, and an optional gap between columns.
 * Returns at least 1 if there are items, 0 if items is 0.
 */
export function fitColumns(
  items: number,
  maxWidth: number,
  minItemWidth: number,
  gap: number = 0,
): number {
  if (items <= 0) return 0;
  if (minItemWidth <= 0) return items;
  if (maxWidth <= 0) return 1;

  // Binary-style: increment columns while they fit
  let cols = 1;
  while (cols < items) {
    const needed = cols * minItemWidth + (cols - 1) * gap;
    if (needed > maxWidth) break;
    const nextNeeded = (cols + 1) * minItemWidth + cols * gap;
    if (nextNeeded > maxWidth) break;
    cols++;
  }

  return cols;
}

/**
 * Distribute total width among items according to weight ratios.
 * Returns an integer array that sums to totalWidth (remainder goes to
 * the first items). Empty weights array returns [].
 */
export function distributeWidths(
  totalWidth: number,
  weights: number[],
): number[] {
  if (weights.length === 0) return [];
  if (totalWidth <= 0) return weights.map(() => 0);

  const totalWeight = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (totalWeight === 0) {
    // Equal distribution when all weights are zero
    const base = Math.floor(totalWidth / weights.length);
    const remainder = totalWidth - base * weights.length;
    return weights.map((_, i) => base + (i < remainder ? 1 : 0));
  }

  const rawWidths = weights.map((w) =>
    Math.floor((Math.max(0, w) / totalWeight) * totalWidth),
  );

  // Distribute remainder to maintain exact total
  let assigned = rawWidths.reduce((sum, w) => sum + w, 0);
  let remainder = totalWidth - assigned;
  for (let i = 0; i < rawWidths.length && remainder > 0; i++) {
    rawWidths[i]++;
    remainder--;
  }

  return rawWidths;
}
