/**
 * Focused-display detection per spec §8.2.
 *
 * `peekaboo list screens --json` returns: { screens: [{ index, displayID,
 * isPrimary, scaleFactor, position, resolution }], primaryIndex }.
 *
 * `peekaboo list windows --json --app frontmost` returns the focused window
 * with its global-coord bounds. We match those bounds against each screen's
 * (position, resolution) rectangle to decide which display is "focused".
 *
 * Fallback when window enumeration fails: primary display.
 */

import { runPeekaboo, type RunOpts } from "./peekaboo-cli.js";

export interface ScreenInfo {
	index: number;
	displayID: number;
	name?: string;
	isPrimary: boolean;
	scaleFactor: number;
	position: { x: number; y: number };
	resolution: { width: number; height: number };
}

interface ScreenListData {
	screens: ScreenInfo[];
	primaryIndex: number;
}

interface FrontWindowData {
	windows?: Array<{
		bounds?: { x: number; y: number; width: number; height: number };
		app?: string;
		title?: string;
	}>;
}

export async function listScreens(opts: RunOpts = {}): Promise<ScreenInfo[]> {
	const r = await runPeekaboo<ScreenListData>(["list", "screens"], opts);
	if (!r.ok) {
		throw new Error(`eyes/display: peekaboo list screens failed: ${r.reason}`);
	}
	return r.data.screens;
}

export async function getPrimaryScreen(opts: RunOpts = {}): Promise<ScreenInfo> {
	const screens = await listScreens(opts);
	const primary = screens.find((s) => s.isPrimary) ?? screens[0];
	if (!primary) throw new Error("eyes/display: no screens reported by peekaboo list screens");
	return primary;
}

export async function getFocusedScreen(opts: RunOpts = {}): Promise<ScreenInfo> {
	const screens = await listScreens(opts);
	if (screens.length === 0) {
		throw new Error("eyes/display: no screens reported by peekaboo list screens");
	}
	if (screens.length === 1) return screens[0]!;

	const front = await runPeekaboo<FrontWindowData>(
		["list", "windows", "--app", "frontmost"],
		opts,
	);
	if (!front.ok) {
		// Window enumeration is brittle; fall back to primary rather than throwing.
		return getPrimaryScreen(opts);
	}
	const w = front.data.windows?.[0];
	if (!w?.bounds) return getPrimaryScreen(opts);

	// Window center point.
	const cx = w.bounds.x + w.bounds.width / 2;
	const cy = w.bounds.y + w.bounds.height / 2;

	for (const s of screens) {
		const right = s.position.x + s.resolution.width;
		const bottom = s.position.y + s.resolution.height;
		if (cx >= s.position.x && cx < right && cy >= s.position.y && cy < bottom) {
			return s;
		}
	}
	return getPrimaryScreen(opts);
}
