/**
 * Calculate dimensions that fit within max width and height while preserving aspect ratio.
 * @param srcW - Source width
 * @param srcH - Source height
 * @param maxW - Maximum allowed width
 * @param maxH - Maximum allowed height
 * @returns Scaled dimensions
 */
export function fit(srcW: number, srcH: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(maxW / srcW, maxH / srcH);
  return { width: srcW * scale, height: srcH * scale };
}

/**
 * Calculate crop rectangle to fill target dimensions while preserving aspect ratio.
 * @param srcW - Source width
 * @param srcH - Source height
 * @param targetW - Target width
 * @param targetH - Target height
 * @returns Crop rectangle with x, y, width, height
 */
export function fill(srcW: number, srcH: number, targetW: number, targetH: number): { x: number; y: number; width: number; height: number } {
  const scale = Math.max(targetW / srcW, targetH / srcH);
  const scaledW = srcW * scale;
  const scaledH = srcH * scale;
  const x = (scaledW - targetW) / 2;
  const y = (scaledH - targetH) / 2;
  return { x, y, width: targetW, height: targetH };
}

/**
 * Calculate scale factor to cover target dimensions while preserving aspect ratio.
 * @param srcW - Source width
 * @param srcH - Source height
 * @param targetW - Target width
 * @param targetH - Target height
 * @returns Scale factor
 */
export function cover(srcW: number, srcH: number, targetW: number, targetH: number): number {
  return Math.max(targetW / srcW, targetH / srcH);
}

/**
 * Calculate scale factor to contain within target dimensions while preserving aspect ratio.
 * @param srcW - Source width
 * @param srcH - Source height
 * @param targetW - Target width
 * @param targetH - Target height
 * @returns Scale factor
 */
export function contain(srcW: number, srcH: number, targetW: number, targetH: number): number {
  return Math.min(targetW / srcW, targetH / srcH);
}