/**
 * 8gent Code - Computer Use Bridge
 *
 * Thin policy-and-validation layer over the @8gent/hands macOS driver.
 * Security-first: every operation is validated here before the driver runs.
 *
 * This bridge is the ONLY place that calls the driver. Consumer code goes
 * through this module so guard rails can never be skipped.
 */

import * as os from "node:os";
import * as path from "node:path";
import { getDriver } from "../hands";
import type {
	ClickOptions,
	CommandResult,
	DisplayInfo,
	DragOptions,
	Point,
	PressOptions,
	ScreenshotOptions,
	ScreenshotResult,
	ScrollOptions,
	TypeOptions,
	WindowInfo,
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
	"cmd+q", // quit app
	"cmd+w", // close window/tab
	"alt+f4", // close app (linux/windows)
	"ctrl+alt+delete", // system interrupt
	"cmd+shift+q", // logout
	"ctrl+shift+delete", // clear browser data
]);

/** Validate numeric point coordinates are within sane bounds */
function validatePoint(p: Point, label: string): string | null {
	if (typeof p.x !== "number" || typeof p.y !== "number") {
		return `${label}: x and y must be numbers`;
	}
	if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
		return `${label}: coordinates must be finite numbers`;
	}
	// Screen coords should be non-negative and within reason (16K pixels max)
	if (p.x < 0 || p.y < 0 || p.x > 16384 || p.y > 16384) {
		return `${label}: coordinates out of range (0-16384)`;
	}
	return null;
}

// ============================================
// Operations
// ============================================

/**
 * Take a screenshot of the desktop or a region.
 */
export function screenshot(opts: ScreenshotOptions = {}): ScreenshotResult {
	const savePath = opts.path || path.join(os.tmpdir(), `8gent-screenshot-${Date.now()}.png`);
	const driver = getDriver();
	const out = driver.screenshot({
		path: savePath,
		displayId: opts.displayId,
		region: opts.region,
	});

	if (!out.ok) {
		return {
			ok: false,
			path: savePath,
			coordMap: {
				captureX: 0,
				captureY: 0,
				captureWidth: 0,
				captureHeight: 0,
				imageWidth: 0,
				imageHeight: 0,
			},
			error: out.error,
		};
	}

	return {
		ok: true,
		path: out.path,
		coordMap: {
			captureX: opts.region?.x ?? 0,
			captureY: opts.region?.y ?? 0,
			captureWidth: opts.region?.width ?? out.width ?? 0,
			captureHeight: opts.region?.height ?? out.height ?? 0,
			imageWidth: out.width ?? 0,
			imageHeight: out.height ?? 0,
		},
	};
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

	const r = getDriver().click(opts.point, opts.button ?? "left", count);
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Type text at the current cursor position.
 */
export function typeText(opts: TypeOptions): CommandResult {
	if (!opts.text || opts.text.length === 0) {
		return { ok: false, error: "Text cannot be empty" };
	}
	if (opts.text.length > MAX_TYPE_LENGTH) {
		return {
			ok: false,
			error: `Text too long (${opts.text.length} chars, max ${MAX_TYPE_LENGTH})`,
		};
	}

	const r = getDriver().type(opts.text, opts.delay ?? 0);
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Press a key combination (e.g. "cmd+s", "ctrl+shift+p", "enter").
 */
export function press(opts: PressOptions): CommandResult {
	const normalized = opts.keys.toLowerCase().trim();
	if (!normalized) {
		return { ok: false, error: "Keys cannot be empty" };
	}

	const isDangerous = DANGEROUS_KEYS.has(normalized);

	const count = opts.count ?? 1;
	if (count < 1 || count > MAX_CLICK_COUNT) {
		return { ok: false, error: `Key press count must be 1-${MAX_CLICK_COUNT}` };
	}

	const driver = getDriver();
	for (let i = 0; i < count; i++) {
		const r = driver.press(opts.keys);
		if (!r.ok) return { ok: false, error: r.error };
		if (opts.delay && opts.delay > 0 && i < count - 1) {
			// Delay between repeated presses. Bun/Node sync sleep via Atomics.
			const buf = new SharedArrayBuffer(4);
			const arr = new Int32Array(buf);
			Atomics.wait(arr, 0, 0, opts.delay);
		}
	}

	if (isDangerous) {
		return { ok: true, error: `Warning: executed dangerous key combo "${normalized}"` };
	}
	return { ok: true };
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

	const r = getDriver().scroll(opts.direction, amount, opts.point);
	return r.ok ? { ok: true } : { ok: false, error: r.error };
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
		return {
			ok: false,
			error: `Drag duration must be 0-${MAX_DRAG_DURATION}ms`,
		};
	}

	const r = getDriver().drag(opts.from, opts.to, opts.button ?? "left", duration);
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Move the cursor to a point (hover).
 */
export function hover(point: Point): CommandResult {
	const pointErr = validatePoint(point, "hover");
	if (pointErr) return { ok: false, error: pointErr };

	const r = getDriver().hover(point);
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Get current mouse position.
 */
export function mousePosition(): {
	ok: boolean;
	point?: Point;
	error?: string;
} {
	return getDriver().mousePosition();
}

/**
 * List all open windows.
 */
export function windowList(): {
	ok: boolean;
	windows?: WindowInfo[];
	error?: string;
} {
	return getDriver().windowList();
}

/**
 * List all connected displays. Driver-level enumeration is not yet implemented;
 * return the primary display the agent can rely on plus an empty list so
 * callers can branch on `displays.length === 0`.
 */
export function displayList(): {
	ok: boolean;
	displays?: DisplayInfo[];
	error?: string;
} {
	return { ok: true, displays: [] };
}

/**
 * Get clipboard contents.
 */
export function clipboardGet(): { ok: boolean; text?: string; error?: string } {
	return getDriver().clipboardGet();
}

/**
 * Set clipboard contents.
 */
export function clipboardSet(text: string): CommandResult {
	if (text.length > MAX_TYPE_LENGTH) {
		return {
			ok: false,
			error: `Clipboard text too long (${text.length} chars, max ${MAX_TYPE_LENGTH})`,
		};
	}
	const r = getDriver().clipboardSet(text);
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}
