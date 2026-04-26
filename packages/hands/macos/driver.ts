/**
 * 8gent-hands macOS driver.
 *
 * Implements the `HandsDriver` interface against macOS native primitives:
 *  - `screencapture` (built-in) for screenshots.
 *  - `cliclick` (Homebrew) for mouse and keyboard.
 *  - `osascript` (built-in) for scroll fallback and clipboard.
 *
 * The driver is deliberately stateless. Every call shells out, returns a
 * deterministic result envelope, and never throws. The caller (the bridge)
 * is responsible for policy checks before invoking us.
 *
 * Why shell out instead of N-API: zero native compilation, no Xcode toolchain
 * required to install, no codesigning headaches. The cost is one process
 * spawn per action, which is fine because the agent loop is human-paced.
 */

import { execFileSync } from "node:child_process";
import {
	captureScreen,
	screenshotAvailable,
	type ScreenshotInput,
	type ScreenshotOutput,
	type ScreenshotFailure,
} from "./screenshot";
import {
	click as macClick,
	typeText as macType,
	press as macPress,
	scroll as macScroll,
	hover as macHover,
	drag as macDrag,
	mousePosition as macMousePosition,
	inputAvailable,
	type ClickInput,
	type TypeInput,
	type PressInput,
	type ScrollInput,
	type DragInput,
	type InputResult,
} from "./input";

export interface DriverCapabilities {
	screenshot: boolean;
	input: boolean;
	platform: NodeJS.Platform;
}

export interface MacOSHandsDriver {
	readonly id: string;
	readonly platform: "darwin";
	capabilities(): DriverCapabilities;
	screenshot(opts?: ScreenshotInput): ScreenshotOutput | ScreenshotFailure;
	click(opts: ClickInput): InputResult;
	type(opts: TypeInput): InputResult;
	press(opts: PressInput): InputResult;
	scroll(opts: ScrollInput): InputResult;
	hover(opts: { x: number; y: number }): InputResult;
	drag(opts: DragInput): InputResult;
	mousePosition(): { ok: boolean; x?: number; y?: number; error?: string };
	clipboardGet(): { ok: boolean; text?: string; error?: string };
	clipboardSet(text: string): InputResult;
}

const DRIVER_ID = "hands-macos-v0";

function platformGuard(): InputResult | null {
	if (process.platform !== "darwin") {
		return {
			ok: false,
			error: `hands-macos requires darwin; got ${process.platform}. Linux and Windows drivers are not implemented.`,
		};
	}
	return null;
}

/** Read system clipboard via `pbpaste`. */
function clipboardGet(): { ok: boolean; text?: string; error?: string } {
	const guard = platformGuard();
	if (guard) return { ok: false, error: guard.error };
	try {
		const out = execFileSync("/usr/bin/pbpaste", [], {
			timeout: 3_000,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
		});
		return { ok: true, text: out };
	} catch (err: any) {
		return { ok: false, error: err?.message || "pbpaste failed" };
	}
}

/** Write system clipboard via `pbcopy`. */
function clipboardSet(text: string): InputResult {
	const guard = platformGuard();
	if (guard) return guard;
	try {
		execFileSync("/usr/bin/pbcopy", [], {
			input: text,
			timeout: 3_000,
			stdio: ["pipe", "ignore", "pipe"],
			encoding: "utf-8",
		});
		return { ok: true };
	} catch (err: any) {
		return { ok: false, error: err?.message || "pbcopy failed" };
	}
}

/**
 * Build a fresh driver instance. We instantiate per-call rather than as a
 * singleton because state is tracked in the cliclick probe cache, which we
 * want to be process-wide but reset-able for tests.
 */
export function createMacOSDriver(): MacOSHandsDriver {
	return {
		id: DRIVER_ID,
		platform: "darwin",

		capabilities() {
			return {
				screenshot: process.platform === "darwin" && screenshotAvailable(),
				input: process.platform === "darwin" && inputAvailable(),
				platform: process.platform,
			};
		},

		screenshot(opts) {
			const guard = platformGuard();
			if (guard) return { ok: false, error: guard.error ?? "platform unsupported" };
			return captureScreen(opts);
		},

		click(opts) {
			const guard = platformGuard();
			if (guard) return guard;
			return macClick(opts);
		},

		type(opts) {
			const guard = platformGuard();
			if (guard) return guard;
			return macType(opts);
		},

		press(opts) {
			const guard = platformGuard();
			if (guard) return guard;
			return macPress(opts);
		},

		scroll(opts) {
			const guard = platformGuard();
			if (guard) return guard;
			return macScroll(opts);
		},

		hover(opts) {
			const guard = platformGuard();
			if (guard) return guard;
			return macHover(opts);
		},

		drag(opts) {
			const guard = platformGuard();
			if (guard) return guard;
			return macDrag(opts);
		},

		mousePosition() {
			const guard = platformGuard();
			if (guard) return { ok: false, error: guard.error };
			return macMousePosition();
		},

		clipboardGet,
		clipboardSet,
	};
}
