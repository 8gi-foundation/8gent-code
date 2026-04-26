// @8gent/hands - macOS desktop driver for the 8gent Computer agent.
//
// Pattern adapted (not vendored) from trycua/cua (MIT). We re-implement the
// macOS shell-out approach in idiomatic 8gent-code style: synchronous
// envelopes, no native bindings, no Xcode toolchain required to install.
//
// Surface:
//  - `createDriver()` returns the platform-appropriate HandsDriver. On
//    darwin this is the macOS driver; on other platforms it is a stub that
//    returns "not implemented" envelopes so the agent loop never crashes.
//  - `HandsDriver` is the stable interface consumers should depend on.
//
// See: docs/prd/8gent-computer/architecture.md (PR #1747) and parent PRD #1746.

import { createMacOSDriver, type MacOSHandsDriver } from "./macos/driver";
import type {
	ClickInput,
	DragInput,
	InputResult,
	PressInput,
	ScrollInput,
	TypeInput,
} from "./macos/input";
import type {
	ScreenshotFailure,
	ScreenshotInput,
	ScreenshotOutput,
} from "./macos/screenshot";

export type {
	ClickInput,
	DragInput,
	InputResult,
	PressInput,
	ScrollInput,
	TypeInput,
	ScreenshotFailure,
	ScreenshotInput,
	ScreenshotOutput,
};

export interface HandsDriver {
	/** Human-readable driver identity, e.g. "hands-macos-v0". */
	readonly id: string;
	/** Underlying OS the driver targets. */
	readonly platform: NodeJS.Platform;

	/** Probe what the driver can actually do on this machine. */
	capabilities(): {
		screenshot: boolean;
		input: boolean;
		platform: NodeJS.Platform;
	};

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

/**
 * Stub driver for non-macOS platforms. Every call returns ok:false with a
 * clear message, so the agent loop can degrade gracefully instead of
 * crashing. We still report platform/id so callers can log it.
 */
function createStubDriver(): HandsDriver {
	const notImplemented = `hands driver not implemented for ${process.platform}; only darwin is supported in v0`;
	const fail = (): InputResult => ({ ok: false, error: notImplemented });
	return {
		id: `hands-${process.platform}-stub`,
		platform: process.platform,
		capabilities() {
			return { screenshot: false, input: false, platform: process.platform };
		},
		screenshot() {
			return { ok: false, error: notImplemented };
		},
		click: fail,
		type: fail,
		press: fail,
		scroll: fail,
		hover: fail,
		drag: fail,
		mousePosition() {
			return { ok: false, error: notImplemented };
		},
		clipboardGet() {
			return { ok: false, error: notImplemented };
		},
		clipboardSet: fail,
	};
}

/**
 * Build the platform-appropriate driver. Returns a working macOS driver on
 * darwin and a safe stub elsewhere. Callers should check
 * `driver.capabilities()` before relying on screenshot or input.
 */
export function createDriver(): HandsDriver {
	if (process.platform === "darwin") {
		return createMacOSDriver() satisfies MacOSHandsDriver;
	}
	return createStubDriver();
}

/** Removed in this release. Retained as `false` for any consumer that grep'd it. */
export const HANDS_PLACEHOLDER = false as const;

// Re-export the macOS driver factory for callers that want the concrete type.
export { createMacOSDriver, type MacOSHandsDriver };
