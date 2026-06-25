/**
 * Media Tools - Toolshed registration for Wave 74
 *
 * Registers generate-sprite and list-sprites as first-class 8gent tools.
 * These surface the media harness in the pill, TUI, and relay command surface.
 */

import { listAssets, generate, type GenerateOptions, type MediaAsset } from "../../../gamedev/harness.js";

// ── Tool Definitions ─────────────────────────────────────────────

export const TOOLS = [
	{
		name: "generate-sprite",
		description:
			"Generate a 2D sprite animation from a natural language prompt. " +
			"Creates a sprite sheet PNG + animated GIF/WebP. " +
			"Local-first (no external API by default), cloud fallback if OPENAI_API_KEY is set. " +
			"Assets saved to ~/.8gent/assets/media/.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"Natural language description of the sprite. " +
						"Examples: 'a walking robot', 'a happy cat idle loop', 'a fire particle effect', 'a pixel-art sword and shield'",
				},
				frameCount: {
					type: "number",
					description: "Number of frames in the animation (default: 8, max: 32)",
					minimum: 1,
					maximum: 32,
					default: 8,
				},
				loop: {
					type: "boolean",
					description: "Whether the animation loops (default: true)",
					default: true,
				},
				format: {
					type: "string",
					description: "Output format: gif | webp | png (default: gif)",
					enum: ["gif", "webp", "png"],
					default: "gif",
				},
				style: {
					type: "string",
					description: "Art style (default: pixel-art)",
					enum: ["pixel-art", "hand-drawn", "3d-render", "anime", "painterly"],
					default: "pixel-art",
				},
				forceCloud: {
					type: "boolean",
					description: "Force cloud generation (DALL-E) even if local tools are available",
					default: false,
				},
			},
			required: ["prompt"],
		},
		capabilities: ["creative", "media"],
		permissions: [],
	},

	{
		name: "list-sprites",
		description:
			"List all generated sprite assets from the local media library. " +
			"Shows the most recent first. Use type to filter by category.",
		inputSchema: {
			type: "object",
			properties: {
				type: {
					type: "string",
					description: "Filter by asset type",
					enum: ["sprite", "animation", "tileset", "ui", "item", "particle"],
				},
				limit: {
					type: "number",
					description: "Maximum number of assets to return (default: 20)",
					minimum: 1,
					maximum: 200,
					default: 20,
				},
			},
		},
		capabilities: ["creative", "media"],
		permissions: [],
	},
];

// ── Tool Implementations ─────────────────────────────────────────

export async function generateSpriteTool(input: Record<string, unknown>): Promise<string> {
	const options: GenerateOptions = {
		prompt: String(input.prompt || ""),
		frameCount: Number(input.frameCount || 8),
		loop: input.loop !== false,
		format: (input.format as "gif" | "webp" | "png") || "gif",
		style: (input.style as "pixel-art" | "hand-drawn" | "3d-render" | "anime" | "painterly") || "pixel-art",
		forceCloud: Boolean(input.forceCloud),
	};

	const result = await generate(options);

	if (result.success) {
		return JSON.stringify({
			ok: true,
			path: result.path,
			sheet: result.sheetPath,
			animated: result.animatedPath,
			manifest: result.manifest,
		}, null, 2);
	} else {
		return JSON.stringify({
			ok: false,
			reason: result.reason,
			path: result.path,
			hint: "Install sharp (bun add sharp) for local generation, or set OPENAI_API_KEY for cloud fallback.",
		}, null, 2);
	}
}

export async function listSpritesTool(input: Record<string, unknown>): Promise<string> {
	const type = input.type as MediaAsset["type"] | undefined;
	const limit = Math.min(Number(input.limit || 20), 200);

	const assets = listAssets(type).slice(0, limit);

	return JSON.stringify({
		count: assets.length,
		assets: assets.map((a) => ({
			id: a.id,
			name: a.name,
			type: a.type,
			prompt: a.prompt,
			sheet: a.sheetPath,
			animated: a.animatedPath,
			manifest: a.manifest,
			createdAt: new Date(a.createdAt).toISOString(),
			path: a.path,
		})),
	}, null, 2);
}
