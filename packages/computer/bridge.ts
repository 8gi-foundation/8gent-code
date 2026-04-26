/**
 * 8gent Code - Computer Use Bridge
 *
 * Thin policy-and-validation layer over @8gent/hands. Every operation runs
 * the same input checks (point bounds, type length, click count) before
 * delegating to the platform driver. The bridge is the only place in the
 * codebase that talks to the driver directly; consumers go through here.
 *
 * Driver replacement (April 2026): we used to shell out to `npx usecomputer`
 * for every call, which spawned a Node process per action. The driver is
 * now in-process via @8gent/hands, which on macOS shells out to
 * `screencapture` and `cliclick` directly. Same security guards, no extra
 * Node bootstrap.
 */

import * as os from "node:os";
import * as path from "node:path";
import { createDriver, type HandsDriver } from "../hands/index";
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
// Driver wiring
// ============================================

let cachedDriver: HandsDriver | null = null;

/**
 * Resolve the active hands driver. Cached after first call. Tests can call
 * `resetDriver()` to force a re-resolution after install or env changes.
 */
function getDriver(): HandsDriver {
	if (!cachedDriver) cachedDriver = createDriver();
	return cachedDriver;
}

/** Reset the cached driver. Test-only, but safe in production. */
export function resetDriver(): void {
	cachedDriver = null;
}

// ============================================
// Operations
// ============================================

/**
 * Take a screenshot of the desktop or a region.
 */
export function screenshot(opts: ScreenshotOptions = {}): ScreenshotResult {
	const savePath =
		opts.path || path.join(os.tmpdir(), `8gent-screenshot-${Date.now()}.png`);
	const driver = getDriver();

	const result = driver.screenshot({
		path: savePath,
		displayId: opts.displayId,
		region: opts.region,
		includeBuffer: false,
	});

	if (!result.ok) {
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
			error: result.error,
		};
	}

	const coordMap = {
		captureX: opts.region?.x ?? 0,
		captureY: opts.region?.y ?? 0,
		captureWidth: opts.region?.width ?? 1920,
		captureHeight: opts.region?.height ?? 1080,
		// We do not downscale at the bridge layer. Coord-map normalization
		// happens upstream in packages/computer/coord-map.ts when the agent
		// asks for a scaled view; the raw screenshot is at native resolution.
		imageWidth: opts.region?.width ?? 1920,
		imageHeight: opts.region?.height ?? 1080,
	};

	return { ok: true, path: result.path, coordMap };
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

	return getDriver().click({
		x: opts.point.x,
		y: opts.point.y,
		button: opts.button,
		count,
	});
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

	return getDriver().type({ text: opts.text, delay: opts.delay });
}

/**
 * Press a key combination (e.g. "cmd+s", "ctrl+shift+p", "enter").
 */
export function press(opts: PressOptions): CommandResult {
	const normalized = opts.keys.toLowerCase().trim();
	if (!normalized) {
		return { ok: false, error: "Keys cannot be empty" };
	}

	// Warn on dangerous combos but do not hard-block (policy engine handles that)
	const isDangerous = DANGEROUS_KEYS.has(normalized);

	const count = opts.count ?? 1;
	if (count < 1 || count > MAX_CLICK_COUNT) {
		return { ok: false, error: `Key press count must be 1-${MAX_CLICK_COUNT}` };
	}

	const result = getDriver().press({
		keys: opts.keys,
		count,
		delay: opts.delay,
	});
	if (isDangerous && result.ok) {
		return {
			...result,
			error: `Warning: executed dangerous key combo "${normalized}"`,
		};
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

	return getDriver().scroll({
		direction: opts.direction,
		amount,
		x: opts.point?.x,
		y: opts.point?.y,
	});
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

	return getDriver().drag({
		fromX: opts.from.x,
		fromY: opts.from.y,
		toX: opts.to.x,
		toY: opts.to.y,
		button: opts.button,
		duration,
	});
}

/**
 * Move the cursor to a point (hover).
 */
export function hover(point: Point): CommandResult {
	const pointErr = validatePoint(point, "hover");
	if (pointErr) return { ok: false, error: pointErr };

	return getDriver().hover({ x: point.x, y: point.y });
}

/**
 * Get current mouse position.
 */
export function mousePosition(): {
	ok: boolean;
	point?: Point;
	error?: string;
} {
	const result = getDriver().mousePosition();
	if (!result.ok) return { ok: false, error: result.error };
	if (typeof result.x !== "number" || typeof result.y !== "number") {
		return { ok: false, error: "mouse-position returned no coordinates" };
	}
	return { ok: true, point: { x: result.x, y: result.y } };
}

/**
 * List all open windows.
 *
 * Not yet implemented in the macOS driver; would require AppKit via
 * a Swift helper or a python-objc shell-out. Returns ok:true with an
 * empty list so the agent does not crash, and logs the limitation in
 * the error field for diagnostic purposes.
 */
export function windowList(): {
	ok: boolean;
	windows?: WindowInfo[];
	error?: string;
} {
	return {
		ok: true,
		windows: [],
		error:
			"window-list is not implemented in hands-macos-v0; will land with the AppKit helper in a follow-up",
	};
}

/**
 * List all connected displays.
 *
 * Same status as windowList: not in v0, returns an empty list so callers
 * do not crash.
 */
export function displayList(): {
	ok: boolean;
	displays?: DisplayInfo[];
	error?: string;
} {
	return {
		ok: true,
		displays: [],
		error:
			"display-list is not implemented in hands-macos-v0; will land with the AppKit helper in a follow-up",
	};
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
	return getDriver().clipboardSet(text);
}
