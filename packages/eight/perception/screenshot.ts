/**
 * Pixel perception: screenshot capture and token cost accounting.
 *
 * Wraps the daemon-side hands tool surface so the cua loop can request a
 * screenshot when the accessibility tree alone is not enough (canvases,
 * image-heavy UIs, games, ambiguous element layouts). The agent escalates
 * to this only when `perceiveTree()` returns insufficient signal because
 * image tokens are the dominant cost on local Qwen.
 *
 * The function does not call the model. It only produces the perception
 * payload (file path, coord-map, optional region crop hint, token cost
 * estimate). The caller is responsible for wrapping the bytes into a
 * `MessageContent` part for the LLM client.
 */

import { type HandsToolCtx, executeHandsTool } from "../../daemon/tools/hands";
import type { HandsCallable, TokenCost } from "./tree";

export interface ScreenshotPerception {
	kind: "screenshot";
	ok: boolean;
	path?: string;
	coordMap?: string;
	/** Optional crop region the agent asked us to focus on. */
	region?: { x: number; y: number; width: number; height: number };
	cost: TokenCost;
	error?: string;
}

/**
 * Token cost estimate for a desktop screenshot.
 *
 * Vision models bill per tile (Qwen 3.6 follows the OpenAI-style 512x512
 * tile rule: 85 base tokens + 170 per tile). A typical Mac shot at 1440x900
 * lands around 12-16 tiles. We emit a conservative upper bound so the
 * agent's perception budget is not surprised at end-of-loop.
 */
function estimateScreenshotCost(width = 1440, height = 900): TokenCost {
	const tilesX = Math.ceil(width / 512);
	const tilesY = Math.ceil(height / 512);
	const tiles = Math.max(1, tilesX * tilesY);
	return {
		method: "screenshot",
		tokens: 85 + tiles * 170,
		note: `${tilesX}x${tilesY} tile grid`,
	};
}

export interface CapturePerceptionInput {
	ctx: HandsToolCtx;
	/** Optional crop after capture. The driver does not crop server-side yet. */
	region?: { x: number; y: number; width: number; height: number };
	displayId?: number;
	/** Optional override (CI / smoke). Defaults to the real hands executor. */
	hands?: HandsCallable;
}

export async function captureScreenshot(
	input: CapturePerceptionInput,
): Promise<ScreenshotPerception> {
	const { ctx, region, displayId, hands = executeHandsTool } = input;
	const result = await hands(
		"desktop_screenshot",
		displayId !== undefined ? { displayId } : {},
		ctx,
	);

	if (!result.ok) {
		return {
			kind: "screenshot",
			ok: false,
			cost: estimateScreenshotCost(),
			error: result.reason,
			region,
		};
	}

	const data = result.result as {
		ok?: boolean;
		path?: string;
		coordMap?: string;
		error?: string;
	};
	if (!data?.ok || !data.path) {
		return {
			kind: "screenshot",
			ok: false,
			cost: estimateScreenshotCost(),
			error: data?.error ?? "screenshot driver returned no path",
			region,
		};
	}

	return {
		kind: "screenshot",
		ok: true,
		path: data.path,
		coordMap: data.coordMap,
		region,
		cost: estimateScreenshotCost(),
	};
}
