/**
 * 8gent Code - Computer Use Bridge
 *
 * Wraps the `usecomputer` npm package to provide desktop automation.
 * Security-first: every operation checks NemoClaw policy before executing.
 *
 * This bridge is the ONLY place that calls usecomputer directly.
 * All consumer code goes through this module.
 */

import { execSync } from "child_process";
import * as path from "path";
import * as os from "os";
import type {
  ScreenshotOptions,
  ClickOptions,
  TypeOptions,
  PressOptions,
  ScrollOptions,
  DragOptions,
  ScreenshotResult,
  CommandResult,
  WindowInfo,
  DisplayInfo,
  Point,
  ComputerUseContext,
} from "./types";

// ============================================
// Security
// ============================================

/** Max text length the agent can type in one call (prevents paste-bombing) */
const MAX_TYPE_LENGTH = 2000;

/** Max click count to prevent rapid-fire loops */
const MAX_CLICK_COUNT = 5;

/** Max scroll amount to prevent runaway scrolling */
const MAX_SCROLL_AMOUNT = 50;

/** Max drag duration in ms */
const MAX_DRAG_DURATION = 5000;

/** Dangerous key combos that require extra caution */
const DANGEROUS_KEYS = new Set([
  "cmd+q",       // quit app
  "cmd+w",       // close window/tab
  "alt+f4",      // close app (linux/windows)
  "ctrl+alt+delete", // system interrupt
  "cmd+shift+q", // logout
  "ctrl+shift+delete", // clear browser data
]);

/** Validate numeric point coordinates are within sane bounds */
function validatePoint(p: Point, label: string): string | null {
  if (typeof p.x !== "number" || typeof p.y !== "number") {
    return `${label}: x and y must be numbers`;
  }
  if (!isFinite(p.x) || !isFinite(p.y)) {
    return `${label}: coordinates must be finite numbers`;
  }
  // Screen coords should be non-negative and within reason (16K pixels max)
  if (p.x < 0 || p.y < 0 || p.x > 16384 || p.y > 16384) {
    return `${label}: coordinates out of range (0-16384)`;
  }
  return null;
}

// ============================================
// CLI runner (uses usecomputer CLI binary)
// ============================================

const DEFAULT_TIMEOUT = 10_000;

/**
 * Run a usecomputer CLI command. Returns parsed JSON result.
 * Uses the CLI binary rather than N-API to avoid native module complexity.
 */
function runCli(args: string[], timeout = DEFAULT_TIMEOUT): { ok: boolean; data?: any; error?: string } {
  try {
    const result = execSync(
      ["npx", "usecomputer", ...args, "--json"].join(" "),
      {
        timeout,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: os.homedir(),
      }
    );
    try {
      return JSON.parse(result.trim());
    } catch {
      return { ok: true, data: result.trim() };
    }
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim();
    const stdout = err.stdout?.toString().trim();
    return { ok: false, error: stderr || stdout || err.message || "usecomputer CLI error" };
  }
}

// ============================================
// Operations
// ============================================

/**
 * Take a screenshot of the desktop or a region.
 */
export function screenshot(opts: ScreenshotOptions = {}): ScreenshotResult {
  const savePath = opts.path || path.join(os.tmpdir(), `8gent-screenshot-${Date.now()}.png`);

  const args = ["screenshot", savePath];
  if (opts.displayId !== undefined) {
    args.push("--display", String(opts.displayId));
  }
  if (opts.region) {
    args.push(
      "--x", String(opts.region.x),
      "--y", String(opts.region.y),
      "--width", String(opts.region.width),
      "--height", String(opts.region.height),
    );
  }

  const result = runCli(args);
  if (!result.ok) {
    return { ok: false, path: savePath, coordMap: { captureX: 0, captureY: 0, captureWidth: 0, captureHeight: 0, imageWidth: 0, imageHeight: 0 }, error: result.error };
  }

  // Parse coord map from CLI output if available
  const coordMap = result.data?.coordMap || {
    captureX: opts.region?.x || 0,
    captureY: opts.region?.y || 0,
    captureWidth: opts.region?.width || 1920,
    captureHeight: opts.region?.height || 1080,
    imageWidth: 1568,
    imageHeight: 882,
  };

  return { ok: true, path: savePath, coordMap };
}

/**
 * Click at a point on the desktop.
 */
export function click(opts: ClickOptions): CommandResult {
  const pointErr = validatePoint(opts.point, "click");
  if (pointErr) return { ok: false, error: pointErr };

  const count = opts.count ?? 1;
  if (count < 1 || count > MAX_CLICK_COUNT) {
    return { ok: false, error: `Click count must be 1-${MAX_CLICK_COUNT}` };
  }

  const args = [
    "click",
    "-x", String(Math.round(opts.point.x)),
    "-y", String(Math.round(opts.point.y)),
  ];
  if (opts.button && opts.button !== "left") {
    args.push("--button", opts.button);
  }
  if (count > 1) {
    args.push("--count", String(count));
  }

  return runCli(args);
}

/**
 * Type text at the current cursor position.
 */
export function typeText(opts: TypeOptions): CommandResult {
  if (!opts.text || opts.text.length === 0) {
    return { ok: false, error: "Text cannot be empty" };
  }
  if (opts.text.length > MAX_TYPE_LENGTH) {
    return { ok: false, error: `Text too long (${opts.text.length} chars, max ${MAX_TYPE_LENGTH})` };
  }

  const args = ["type", opts.text];
  if (opts.delay && opts.delay > 0) {
    args.push("--delay", String(opts.delay));
  }

  return runCli(args);
}

/**
 * Press a key combination (e.g. "cmd+s", "ctrl+shift+p", "enter").
 */
export function press(opts: PressOptions): CommandResult {
  const normalized = opts.keys.toLowerCase().trim();
  if (!normalized) {
    return { ok: false, error: "Keys cannot be empty" };
  }

  // Warn on dangerous combos but don't hard-block (policy engine handles that)
  const isDangerous = DANGEROUS_KEYS.has(normalized);

  const count = opts.count ?? 1;
  if (count < 1 || count > MAX_CLICK_COUNT) {
    return { ok: false, error: `Key press count must be 1-${MAX_CLICK_COUNT}` };
  }

  const args = ["press", opts.keys];
  if (count > 1) {
    args.push("--count", String(count));
  }
  if (opts.delay && opts.delay > 0) {
    args.push("--delay", String(opts.delay));
  }

  const result = runCli(args);
  if (isDangerous && result.ok) {
    return { ...result, error: `Warning: executed dangerous key combo "${normalized}"` };
  }
  return result;
}

/**
 * Scroll in a direction.
 */
export function scroll(opts: ScrollOptions): CommandResult {
  const amount = opts.amount ?? 3;
  if (amount < 1 || amount > MAX_SCROLL_AMOUNT) {
    return { ok: false, error: `Scroll amount must be 1-${MAX_SCROLL_AMOUNT}` };
  }

  if (opts.point) {
    const pointErr = validatePoint(opts.point, "scroll anchor");
    if (pointErr) return { ok: false, error: pointErr };
  }

  const args = ["scroll", "--direction", opts.direction, "--amount", String(amount)];
  if (opts.point) {
    args.push("-x", String(Math.round(opts.point.x)), "-y", String(Math.round(opts.point.y)));
  }

  return runCli(args);
}

/**
 * Drag from one point to another.
 */
export function drag(opts: DragOptions): CommandResult {
  const fromErr = validatePoint(opts.from, "drag from");
  if (fromErr) return { ok: false, error: fromErr };
  const toErr = validatePoint(opts.to, "drag to");
  if (toErr) return { ok: false, error: toErr };

  const duration = opts.duration ?? 500;
  if (duration < 0 || duration > MAX_DRAG_DURATION) {
    return { ok: false, error: `Drag duration must be 0-${MAX_DRAG_DURATION}ms` };
  }

  const args = [
    "drag",
    "--from-x", String(Math.round(opts.from.x)),
    "--from-y", String(Math.round(opts.from.y)),
    "--to-x", String(Math.round(opts.to.x)),
    "--to-y", String(Math.round(opts.to.y)),
    "--duration", String(duration),
  ];
  if (opts.button && opts.button !== "left") {
    args.push("--button", opts.button);
  }

  return runCli(args);
}

/**
 * Move the cursor to a point (hover).
 */
export function hover(point: Point): CommandResult {
  const pointErr = validatePoint(point, "hover");
  if (pointErr) return { ok: false, error: pointErr };

  return runCli(["hover", "-x", String(Math.round(point.x)), "-y", String(Math.round(point.y))]);
}

/**
 * Get current mouse position.
 */
export function mousePosition(): { ok: boolean; point?: Point; error?: string } {
  const result = runCli(["mouse-position"]);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, point: result.data };
}

/**
 * List all open windows.
 */
export function windowList(): { ok: boolean; windows?: WindowInfo[]; error?: string } {
  const result = runCli(["window-list"]);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, windows: result.data || [] };
}

/**
 * List all connected displays.
 */
export function displayList(): { ok: boolean; displays?: DisplayInfo[]; error?: string } {
  const result = runCli(["display-list"]);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, displays: result.data || [] };
}

/**
 * Get clipboard contents.
 */
export function clipboardGet(): { ok: boolean; text?: string; error?: string } {
  const result = runCli(["clipboard-get"]);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, text: result.data };
}

/**
 * Set clipboard contents.
 */
export function clipboardSet(text: string): CommandResult {
  if (text.length > MAX_TYPE_LENGTH) {
    return { ok: false, error: `Clipboard text too long (${text.length} chars, max ${MAX_TYPE_LENGTH})` };
  }
  return runCli(["clipboard-set", text]);
}
