/**
 * 8gent-hands macOS screenshot module.
 *
 * Thin wrapper around the system `screencapture` binary. No native bindings,
 * no extra dependencies. The agent gets a PNG buffer plus the on-disk path
 * so it can either embed the image directly or hand the path to a downstream
 * tool. Region capture is supported via the `-R` flag.
 *
 * Pattern adapted from trycua/cua's macOS driver. We do not vendor their
 * code; we re-implement the shell-out and PNG handling in idiomatic
 * 8gent-code style.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScreenshotRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenshotInput {
	/** Optional path to write the PNG to. If omitted, a tmp file is used. */
	path?: string;
	/** Optional display index (0-based). macOS `screencapture -D` is 1-based and we adjust. */
	displayId?: number;
	/** Optional region in screen coordinates. */
	region?: ScreenshotRegion;
	/** If true, also return the raw PNG buffer. Default: true. */
	includeBuffer?: boolean;
	/** If true, delete the file after reading the buffer. Default: false. */
	cleanup?: boolean;
}

export interface ScreenshotOutput {
	ok: true;
	path: string;
	buffer?: Buffer;
}

export interface ScreenshotFailure {
	ok: false;
	error: string;
}

const SCREENCAPTURE_BIN = "/usr/sbin/screencapture";
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Capture the desktop with `screencapture`. Returns a PNG buffer plus the
 * on-disk path. The caller is responsible for cleanup unless `cleanup: true`.
 */
export function captureScreen(
	input: ScreenshotInput = {},
): ScreenshotOutput | ScreenshotFailure {
	const includeBuffer = input.includeBuffer ?? true;
	const cleanup = input.cleanup ?? false;
	const outPath = input.path ?? join(tmpdir(), `8gent-hands-${Date.now()}.png`);

	const args: string[] = ["-x", "-t", "png"]; // -x = silent (no shutter sound)

	if (input.displayId !== undefined) {
		// `screencapture -D` is 1-based; agent-side displayId is 0-based for parity
		// with the rest of packages/computer/.
		args.push("-D", String(input.displayId + 1));
	}

	if (input.region) {
		const { x, y, width, height } = input.region;
		if (
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			!Number.isFinite(width) ||
			!Number.isFinite(height) ||
			width <= 0 ||
			height <= 0
		) {
			return {
				ok: false,
				error: "Invalid region: x/y/width/height must be finite and width/height > 0",
			};
		}
		args.push(
			"-R",
			`${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)}`,
		);
	}

	args.push(outPath);

	try {
		execFileSync(SCREENCAPTURE_BIN, args, {
			timeout: DEFAULT_TIMEOUT_MS,
			stdio: ["ignore", "ignore", "pipe"],
		});
	} catch (err: any) {
		const stderr = err?.stderr?.toString?.() ?? "";
		const msg = stderr.trim() || err?.message || "screencapture failed";
		return { ok: false, error: msg };
	}

	let buffer: Buffer | undefined;
	if (includeBuffer) {
		try {
			buffer = readFileSync(outPath);
		} catch (err: any) {
			return {
				ok: false,
				error: `screencapture wrote no file: ${err?.message ?? err}`,
			};
		}
	}

	if (cleanup) {
		try {
			unlinkSync(outPath);
		} catch {
			// best-effort cleanup; not fatal
		}
	}

	return { ok: true, path: outPath, buffer };
}

/**
 * Probe whether `screencapture` is callable. Cheap check that does not
 * actually capture anything. Returns true on macOS where the binary exists
 * and is executable.
 */
export function screenshotAvailable(): boolean {
	try {
		execFileSync(SCREENCAPTURE_BIN, ["-h"], {
			timeout: 1_000,
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch (err: any) {
		// `screencapture -h` exits non-zero but prints usage. If the file is
		// missing, the spawn itself fails with ENOENT.
		if (err?.code === "ENOENT") return false;
		return true;
	}
}
