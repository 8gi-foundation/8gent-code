/**
 * Focused-display detection per spec §8.2.
 *
 * `8gent-ax-bridge list-screens` returns: { screens: [{ index, displayID,
 * isPrimary, scaleFactor, position, resolution }], primaryIndex }.
 *
 * `8gent-ax-bridge list-windows --json-args {"app":"frontmost"}` returns the
 * focused window with its global-coord bounds. We match those bounds against
 * each screen's (position, resolution) rectangle to decide which display is
 * "focused".
 *
 * Fallback when window enumeration fails: primary display.
 */

import { runBridge, type BridgeRunOpts } from "./ax-bridge.js";

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

export async function listScreens(opts: BridgeRunOpts = {}): Promise<ScreenInfo[]> {
	const r = await runBridge<ScreenListData>("list-screens", {}, opts);
	if (!r.ok) {
		throw new Error(`eyes/display: 8gent-ax-bridge list-screens failed: ${r.reason}`);
	}
	return r.data.screens;
}

export async function getPrimaryScreen(opts: BridgeRunOpts = {}): Promise<ScreenInfo> {
	const screens = await listScreens(opts);
	const primary = screens.find((s) => s.isPrimary) ?? screens[0];
	if (!primary) throw new Error("eyes/display: no screens reported by 8gent-ax-bridge list-screens");
	return primary;
}

export async function getFocusedScreen(opts: BridgeRunOpts = {}): Promise<ScreenInfo> {
	const screens = await listScreens(opts);
	if (screens.length === 0) {
		throw new Error("eyes/display: no screens reported by 8gent-ax-bridge list-screens");
	}
	if (screens.length === 1) return screens[0]!;

	const front = await runBridge<FrontWindowData>(
		"list-windows",
		{ app: "frontmost" },
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
