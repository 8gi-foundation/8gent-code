/**
 * 8gent Code - Computer Use Types
 *
 * Type definitions for desktop automation (Power #10).
 * Security-first: all operations require explicit policy approval.
 */

export interface Point {
  x: number;
  y: number;
}

export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ScreenshotOptions {
  /** File path to save screenshot (auto-generated if omitted) */
  path?: string;
  /** Capture specific display by index */
  displayId?: number;
  /** Capture a region: {x, y, width, height} */
  region?: { x: number; y: number; width: number; height: number };
}

export interface ClickOptions {
  point: Point;
  button?: MouseButton;
  count?: number;
}

export interface TypeOptions {
  text: string;
  /** Delay between keystrokes in ms (default: 0) */
  delay?: number;
}

export interface PressOptions {
  /** Key combo, e.g. "cmd+s", "ctrl+shift+p", "enter" */
  keys: string;
  count?: number;
  delay?: number;
}

export interface ScrollOptions {
  direction: ScrollDirection;
  amount?: number;
  /** Anchor point to scroll at (moves cursor there first) */
  point?: Point;
}

export interface DragOptions {
  from: Point;
  to: Point;
  button?: MouseButton;
  /** Duration in ms (for smooth drag) */
  duration?: number;
}

export interface CoordMap {
  /** Original capture region */
  captureX: number;
  captureY: number;
  captureWidth: number;
  captureHeight: number;
  /** Scaled image dimensions */
  imageWidth: number;
  imageHeight: number;
}

export interface ScreenshotResult {
  ok: boolean;
  path: string;
  coordMap: CoordMap;
  error?: string;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

export interface WindowInfo {
  id: number;
  title: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  width: number;
  height: number;
  isPrimary: boolean;
}

/** Security context passed to the policy engine before every operation */
export interface ComputerUseContext {
  action: string;
  point?: Point;
  text?: string;
  keys?: string;
  path?: string;
}
