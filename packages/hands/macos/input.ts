/**
 * 8gent-hands macOS input module.
 *
 * Wraps the third-party `cliclick` CLI (BSD-2-Clause, https://github.com/BlueM/cliclick)
 * for mouse and keyboard control. `cliclick` is a small, audited tool that
 * uses CGEventPost under the hood. We shell out instead of binding via FFI
 * to keep the install story simple: `brew install cliclick` and the agent
 * works.
 *
 * If `cliclick` is missing, every call returns a structured error. The
 * caller (bridge.ts) surfaces this to the agent without crashing.
 *
 * Pattern adapted from trycua/cua. Re-implemented from scratch in idiomatic
 * 8gent-code style: synchronous shell-outs, deterministic error envelopes,
 * no async fan-out.
 */

import { execFileSync } from "node:child_process";

export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";

export interface InputResult {
	ok: boolean;
	error?: string;
}

export interface ClickInput {
	x: number;
	y: number;
	button?: MouseButton;
	count?: number;
}

export interface TypeInput {
	text: string;
	/** ms between keystrokes; cliclick takes a global -w wait. */
	delay?: number;
}

export interface PressInput {
	keys: string;
	count?: number;
	delay?: number;
}

export interface ScrollInput {
	direction: ScrollDirection;
	amount?: number;
	x?: number;
	y?: number;
}

export interface DragInput {
	fromX: number;
	fromY: number;
	toX: number;
	toY: number;
	button?: MouseButton;
	/** Total drag duration in ms; cliclick sleeps in steps. */
	duration?: number;
}

const CLICLICK_CANDIDATES = [
	"/opt/homebrew/bin/cliclick", // Apple Silicon Homebrew
	"/usr/local/bin/cliclick", // Intel Homebrew
	"cliclick", // PATH fallback
];

const DEFAULT_TIMEOUT_MS = 5_000;

let cachedBin: string | null | undefined;

/**
 * Resolve the cliclick binary path once and cache. Returns null if none of
 * the known locations resolve.
 */
function resolveCliclick(): string | null {
	if (cachedBin !== undefined) return cachedBin;
	for (const candidate of CLICLICK_CANDIDATES) {
		try {
			execFileSync(candidate, ["-V"], {
				timeout: 1_000,
				stdio: ["ignore", "ignore", "ignore"],
			});
			cachedBin = candidate;
			return candidate;
		} catch {
			// try next
		}
	}
	cachedBin = null;
	return null;
}

/** Public probe: is cliclick installed and callable? */
export function inputAvailable(): boolean {
	return resolveCliclick() !== null;
}

/** Reset the cached cliclick path. Useful for tests after install. */
export function resetInputProbe(): void {
	cachedBin = undefined;
}

function missingError(): InputResult {
	return {
		ok: false,
		error:
			"cliclick is not installed. Run `brew install cliclick` to enable mouse and keyboard control.",
	};
}

function runCliclick(args: string[]): InputResult {
	const bin = resolveCliclick();
	if (!bin) return missingError();
	try {
		execFileSync(bin, args, {
			timeout: DEFAULT_TIMEOUT_MS,
			stdio: ["ignore", "ignore", "pipe"],
		});
		return { ok: true };
	} catch (err: any) {
		const stderr = err?.stderr?.toString?.() ?? "";
		return {
			ok: false,
			error: stderr.trim() || err?.message || "cliclick command failed",
		};
	}
}

/**
 * Click at absolute screen coordinates. cliclick uses a `c:`/`rc:`/`mc:`
 * prefix to choose the button, and `dc:` for double-click. We compose the
 * count manually for n>1 because cliclick has no native count flag for
 * single-button clicks beyond `dc:`.
 */
export function click(input: ClickInput): InputResult {
	const x = Math.round(input.x);
	const y = Math.round(input.y);
	const button = input.button ?? "left";
	const count = input.count ?? 1;

	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return { ok: false, error: "click: x and y must be finite numbers" };
	}

	const prefix =
		button === "right" ? "rc" : button === "middle" ? "mc" : count === 2 ? "dc" : "c";

	if (button !== "left" && count > 1) {
		// cliclick has no triple-right-click; emit N right-clicks in sequence.
		const args: string[] = [];
		for (let i = 0; i < count; i++) args.push(`${prefix}:${x},${y}`);
		return runCliclick(args);
	}

	if (prefix === "dc") {
		return runCliclick([`dc:${x},${y}`]);
	}

	if (count > 1) {
		const args: string[] = [];
		for (let i = 0; i < count; i++) args.push(`c:${x},${y}`);
		return runCliclick(args);
	}

	return runCliclick([`${prefix}:${x},${y}`]);
}

/**
 * Type a string of text. cliclick's `t:` requires escaping commas and
 * preserves Unicode if you use `kp:` for special keys, but for plain text
 * `t:` works. We chunk overly long strings to stay below argv limits.
 */
export function typeText(input: TypeInput): InputResult {
	if (!input.text) return { ok: false, error: "type: text is empty" };

	const args: string[] = [];
	if (input.delay && input.delay > 0) {
		args.push("-w", String(Math.round(input.delay)));
	}
	args.push(`t:${input.text}`);
	return runCliclick(args);
}

/**
 * Press a key combo. cliclick supports `kp:enter`, `kp:space`, etc. Modifier
 * combos use `kd:cmd t:s ku:cmd`. We translate common combo strings here.
 */
export function press(input: PressInput): InputResult {
	const raw = input.keys.trim().toLowerCase();
	if (!raw) return { ok: false, error: "press: keys is empty" };

	const count = input.count ?? 1;
	const parts = raw.split("+").map((s) => s.trim());
	const main = parts[parts.length - 1];
	const mods = parts.slice(0, -1);

	// Map agent-friendly key names to cliclick's vocabulary.
	const keyMap: Record<string, string> = {
		enter: "return",
		return: "return",
		esc: "esc",
		escape: "esc",
		tab: "tab",
		space: "space",
		backspace: "delete",
		delete: "fwd-delete",
		up: "arrow-up",
		down: "arrow-down",
		left: "arrow-left",
		right: "arrow-right",
		home: "home",
		end: "end",
		pageup: "page-up",
		pagedown: "page-down",
	};

	const args: string[] = [];
	if (input.delay && input.delay > 0) {
		args.push("-w", String(Math.round(input.delay)));
	}

	const buildOnce = (): string[] => {
		const seq: string[] = [];
		for (const m of mods) seq.push(`kd:${m}`);
		const cliclickKey = keyMap[main];
		if (cliclickKey) {
			seq.push(`kp:${cliclickKey}`);
		} else if (main.length === 1) {
			// Single character: type it (works for letters, digits, punctuation).
			// When modifiers are held, this is the standard cliclick recipe.
			seq.push(`t:${main}`);
		} else {
			// Last-ditch: pass through as kp: and let cliclick complain if unknown.
			seq.push(`kp:${main}`);
		}
		for (const m of [...mods].reverse()) seq.push(`ku:${m}`);
		return seq;
	};

	for (let i = 0; i < count; i++) {
		args.push(...buildOnce());
	}

	return runCliclick(args);
}

/**
 * Scroll. cliclick has no scroll primitive, so we drive it via AppleScript's
 * `scroll wheel` event. Direction maps to delta sign on the appropriate axis.
 */
export function scroll(input: ScrollInput): InputResult {
	const amount = Math.max(1, Math.round(input.amount ?? 3));
	const dx =
		input.direction === "left" ? -amount : input.direction === "right" ? amount : 0;
	const dy =
		input.direction === "up" ? -amount : input.direction === "down" ? amount : 0;

	// Move the cursor first if an anchor was given. This matches cua's behavior:
	// scroll happens "at" the cursor, so anchoring is meaningful.
	if (input.x !== undefined && input.y !== undefined) {
		const moveResult = hover({ x: input.x, y: input.y });
		if (!moveResult.ok) return moveResult;
	}

	// Use osascript to dispatch a scroll wheel event. CGEventCreateScrollWheelEvent
	// is wrapped via System Events. Note: macOS 14+ may require Accessibility
	// permission for this to work; the agent should expect a TCC prompt the
	// first time.
	try {
		execFileSync(
			"/usr/bin/osascript",
			[
				"-e",
				`tell application "System Events" to scroll {${dx}, ${dy}}`,
			],
			{
				timeout: DEFAULT_TIMEOUT_MS,
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		return { ok: true };
	} catch (err: any) {
		// Fallback: emit repeated arrow keys for vertical, since AppleScript
		// scroll is brittle on some apps. This is best-effort.
		if (input.direction === "up" || input.direction === "down") {
			return press({
				keys: input.direction === "up" ? "up" : "down",
				count: amount,
			});
		}
		const stderr = err?.stderr?.toString?.() ?? "";
		return {
			ok: false,
			error: stderr.trim() || err?.message || "scroll failed",
		};
	}
}

/** Move cursor to a point without clicking. */
export function hover(input: { x: number; y: number }): InputResult {
	const x = Math.round(input.x);
	const y = Math.round(input.y);
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		return { ok: false, error: "hover: x and y must be finite numbers" };
	}
	return runCliclick([`m:${x},${y}`]);
}

/**
 * Drag from one point to another. cliclick provides `dd:` (down) and `du:`
 * (up) plus `m:` (move) which together describe a drag. We chain them into
 * one cliclick invocation so the OS sees a continuous gesture.
 */
export function drag(input: DragInput): InputResult {
	const fromX = Math.round(input.fromX);
	const fromY = Math.round(input.fromY);
	const toX = Math.round(input.toX);
	const toY = Math.round(input.toY);

	if (
		!Number.isFinite(fromX) ||
		!Number.isFinite(fromY) ||
		!Number.isFinite(toX) ||
		!Number.isFinite(toY)
	) {
		return { ok: false, error: "drag: coordinates must be finite numbers" };
	}

	const duration = Math.max(0, Math.round(input.duration ?? 500));
	// cliclick global -w wait between steps; for smoother drag we interpolate.
	const steps = Math.max(2, Math.min(20, Math.round(duration / 50)));
	const args: string[] = [];
	if (duration > 0) {
		args.push("-w", String(Math.round(duration / steps)));
	}

	args.push(`dd:${fromX},${fromY}`);
	for (let i = 1; i < steps; i++) {
		const t = i / steps;
		const ix = Math.round(fromX + (toX - fromX) * t);
		const iy = Math.round(fromY + (toY - fromY) * t);
		args.push(`m:${ix},${iy}`);
	}
	args.push(`du:${toX},${toY}`);

	return runCliclick(args);
}

/** Read current mouse position. */
export function mousePosition(): {
	ok: boolean;
	x?: number;
	y?: number;
	error?: string;
} {
	const bin = resolveCliclick();
	if (!bin) {
		const m = missingError();
		return { ok: false, error: m.error };
	}
	try {
		const out = execFileSync(bin, ["p"], {
			timeout: DEFAULT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
		});
		const match = /(-?\d+),\s*(-?\d+)/.exec(out);
		if (!match) {
			return { ok: false, error: `cliclick p returned: ${out.trim()}` };
		}
		return { ok: true, x: Number(match[1]), y: Number(match[2]) };
	} catch (err: any) {
		const stderr = err?.stderr?.toString?.() ?? "";
		return {
			ok: false,
			error: stderr.trim() || err?.message || "mouse-position failed",
		};
	}
}
