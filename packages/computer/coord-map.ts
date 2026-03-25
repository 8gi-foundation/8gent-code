/**
 * 8gent Code - Coordinate Mapping
 *
 * Maps coordinates from a scaled screenshot back to real desktop coordinates.
 * When the agent sees a screenshot (scaled to fit model context), it reasons
 * about pixel positions in the scaled image. This module translates those
 * back to actual screen coordinates for accurate clicking.
 */

import type { Point, CoordMap } from "./types";

/** Max screenshot dimension sent to models (matches usecomputer default) */
export const MAX_SCREENSHOT_DIM = 1568;

/**
 * Calculate the coord map for a screenshot that was scaled down.
 * Returns the mapping needed to translate image coords -> desktop coords.
 */
export function createCoordMap(
  captureX: number,
  captureY: number,
  captureWidth: number,
  captureHeight: number,
  imageWidth: number,
  imageHeight: number,
): CoordMap {
  return { captureX, captureY, captureWidth, captureHeight, imageWidth, imageHeight };
}

/**
 * Translate a point from scaled-screenshot space to real desktop space.
 * The agent clicks at (imageX, imageY) in the screenshot - we map that
 * to the actual screen position.
 */
export function imageToDesktop(imagePoint: Point, coordMap: CoordMap): Point {
  const scaleX = coordMap.captureWidth / coordMap.imageWidth;
  const scaleY = coordMap.captureHeight / coordMap.imageHeight;

  return {
    x: Math.round(coordMap.captureX + imagePoint.x * scaleX),
    y: Math.round(coordMap.captureY + imagePoint.y * scaleY),
  };
}

/**
 * Encode a coord map as a compact string for passing to the agent.
 * Format: "captureX,captureY,captureWidth,captureHeight,imageWidth,imageHeight"
 */
export function encodeCoordMap(cm: CoordMap): string {
  return `${cm.captureX},${cm.captureY},${cm.captureWidth},${cm.captureHeight},${cm.imageWidth},${cm.imageHeight}`;
}

/**
 * Decode a coord map string back into a CoordMap object.
 */
export function decodeCoordMap(encoded: string): CoordMap {
  const parts = encoded.split(",").map(Number);
  if (parts.length !== 6 || parts.some(isNaN)) {
    throw new Error(`Invalid coord map: "${encoded}" - expected 6 comma-separated numbers`);
  }
  return {
    captureX: parts[0],
    captureY: parts[1],
    captureWidth: parts[2],
    captureHeight: parts[3],
    imageWidth: parts[4],
    imageHeight: parts[5],
  };
}
