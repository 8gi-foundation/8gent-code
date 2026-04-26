/**
 * Species Atlas Generator
 *
 * Takes AI-generated body.png for a species and creates a 64x64 sprite atlas
 * compatible with the existing manifest.json format.
 *
 * The body.png is downscaled and placed with animation offsets per state:
 * - idle: slight bob
 * - walk-right/left: horizontal shift + bob
 * - think: still + thought bubble
 * - sleep: lowered + zzz
 * - etc.
 *
 * Usage:
 *   bun run apps/lil-eight/generate-species-atlas.ts --species Drake
 *   bun run apps/lil-eight/generate-species-atlas.ts --species all
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const FRAME_SIZE = 64;
const SPRITE_SIZE = 48; // character fills 48x48 within the 64x64 frame
const PADDING = (FRAME_SIZE - SPRITE_SIZE) / 2;

// Load manifest to match frame counts exactly
const manifestPath = join(import.meta.dir, "sprites", "manifest.json");
const manifest: Record<string, { start: number; count: number }> = JSON.parse(
	readFileSync(manifestPath, "utf-8"),
);

const totalFrames = Object.values(manifest).reduce(
	(sum, s) => sum + s.count,
	0,
);

// Animation transforms per state per frame
function getFrameOffset(
	state: string,
	frame: number,
	count: number,
): { x: number; y: number; scale: number; flipX: boolean } {
	const t = frame / Math.max(1, count - 1); // 0 to 1
	const base = { x: 0, y: 0, scale: 1, flipX: false };

	switch (state) {
		case "idle":
			return { ...base, y: Math.sin((frame * Math.PI) / 2) * -2 };
		case "walk-right":
			return {
				...base,
				x: Math.sin((frame * Math.PI) / 3) * 3,
				y: Math.abs(Math.sin((frame * Math.PI) / 3)) * -3,
			};
		case "walk-left":
			return {
				...base,
				x: -Math.sin((frame * Math.PI) / 3) * 3,
				y: Math.abs(Math.sin((frame * Math.PI) / 3)) * -3,
				flipX: true,
			};
		case "think":
			return { ...base, y: -1 };
		case "success":
			return { ...base, y: Math.sin((frame * Math.PI) / 2) * -5 };
		case "error":
			return { ...base, x: frame % 2 === 0 ? 2 : -2, y: 0 };
		case "sleep":
			return { ...base, y: 3, scale: 0.95 };
		case "wave":
			return { ...base, y: Math.sin((frame * Math.PI) / 2) * -1 };
		case "sit":
			return { ...base, y: 4, scale: 0.9 };
		case "celebrate":
			return { ...base, y: Math.sin((frame * Math.PI) / 3) * -8 };
		case "drag":
			return { ...base, x: frame === 0 ? 3 : -3 };
		case "typing":
			return { ...base, y: frame % 2 === 0 ? -1 : 0 };
		default:
			return base;
	}
}

// Draw decorations (thought bubbles, zzz, sparkles)
function drawDecorations(
	ctx: CanvasRenderingContext2D,
	state: string,
	frame: number,
) {
	switch (state) {
		case "think": {
			// Thought dots
			const dots = (frame % 4) + 1;
			ctx.fillStyle = "#FFFFFF";
			if (dots >= 1) ctx.fillRect(52, 12, 3, 3);
			if (dots >= 2) ctx.fillRect(56, 8, 3, 3);
			if (dots >= 3) ctx.fillRect(58, 4, 4, 4);
			break;
		}
		case "sleep": {
			// Zzz
			ctx.fillStyle = "#8888DD";
			if (frame >= 1) ctx.fillRect(48, 16, 4, 4);
			if (frame >= 2) {
				ctx.fillStyle = "#AAAAFF";
				ctx.fillRect(52, 10, 4, 4);
			}
			if (frame >= 3) {
				ctx.fillStyle = "#CCCCFF";
				ctx.fillRect(54, 4, 5, 5);
			}
			break;
		}
		case "celebrate": {
			// Confetti
			const colors = ["#EF4444", "#22C55E", "#3B82F6", "#F59E0B", "#A78BFA"];
			for (let i = 0; i < 5; i++) {
				const cx = ((frame * 7 + i * 13) % 60) + 2;
				const cy = ((frame * 5 + i * 11) % 50) + 2;
				ctx.fillStyle = colors[i % colors.length];
				ctx.fillRect(cx, cy, 3, 3);
			}
			break;
		}
		case "success": {
			// Star sparkle
			ctx.fillStyle = "#F59E0B";
			const sy = 4 + frame * 2;
			ctx.fillRect(50, sy, 4, 4);
			ctx.fillRect(52, sy - 2, 1, 1);
			ctx.fillRect(52, sy + 5, 1, 1);
			break;
		}
		case "error": {
			// Error X
			ctx.fillStyle = "#EF4444";
			ctx.fillRect(50, 6, 6, 2);
			ctx.fillRect(52, 4, 2, 6);
			break;
		}
		case "typing": {
			// Code particles
			ctx.fillStyle = "#22C55E";
			const px = 10 + ((frame * 8) % 40);
			ctx.fillRect(px, 50 + (frame % 2) * 2, 3, 2);
			ctx.fillRect(px + 8, 52 - (frame % 2) * 2, 4, 2);
			break;
		}
	}
}

async function generateSpeciesAtlas(species: string) {
	const partsDir = join(import.meta.dir, "parts", species);
	const bodyPath = join(partsDir, "body.png");

	if (!existsSync(bodyPath)) {
		console.error(`No body.png for ${species} at ${partsDir}`);
		return false;
	}

	console.log(`Generating atlas for ${species}...`);

	// Load the body image
	const bodyImg = await loadImage(bodyPath);

	// Create atlas canvas
	const atlasCanvas = createCanvas(FRAME_SIZE * totalFrames, FRAME_SIZE);
	const ctx = atlasCanvas.getContext("2d");

	let frameOffset = 0;

	for (const [state, info] of Object.entries(manifest)) {
		for (let f = 0; f < info.count; f++) {
			const offsets = getFrameOffset(state, f, info.count);
			const frameX = (frameOffset + f) * FRAME_SIZE;

			ctx.save();
			ctx.translate(frameX, 0);

			// Draw the species body image, scaled to fit within 48x48, centered in 64x64
			const drawSize = SPRITE_SIZE * offsets.scale;
			const drawPad = (FRAME_SIZE - drawSize) / 2;
			const dx = drawPad + offsets.x;
			const dy = drawPad + offsets.y;

			if (offsets.flipX) {
				ctx.translate(FRAME_SIZE, 0);
				ctx.scale(-1, 1);
			}

			ctx.drawImage(bodyImg, dx, dy, drawSize, drawSize);

			if (offsets.flipX) {
				ctx.scale(-1, 1);
				ctx.translate(-FRAME_SIZE, 0);
			}

			// Draw state-specific decorations
			drawDecorations(ctx as unknown as CanvasRenderingContext2D, state, f);

			ctx.restore();
		}
		frameOffset += info.count;
	}

	// Save atlas
	const outDir = join(import.meta.dir, "sprites");
	const atlasPath = join(outDir, `atlas-${species.toLowerCase()}.png`);
	writeFileSync(atlasPath, atlasCanvas.toBuffer("image/png"));
	console.log(
		`  Saved: sprites/atlas-${species.toLowerCase()}.png (${totalFrames} frames)`,
	);

	return true;
}

// CLI
const args = process.argv.slice(2);
const speciesFlag =
	args.find((a) => a.startsWith("--species="))?.split("=")[1] ||
	(args.indexOf("--species") >= 0
		? args[args.indexOf("--species") + 1]
		: undefined);

if (!speciesFlag) {
	const partsDir = join(import.meta.dir, "parts");
	const available = existsSync(partsDir)
		? readdirSync(partsDir).filter((d) =>
				existsSync(join(partsDir, d, "body.png")),
			)
		: [];
	console.log(
		"Usage: bun run apps/lil-eight/generate-species-atlas.ts --species Drake",
	);
	console.log(
		"       bun run apps/lil-eight/generate-species-atlas.ts --species all",
	);
	console.log(
		`\nSpecies with body.png (${available.length}): ${available.join(", ")}`,
	);
	process.exit(0);
}

if (speciesFlag === "all") {
	const partsDir = join(import.meta.dir, "parts");
	const species = readdirSync(partsDir).filter((d) =>
		existsSync(join(partsDir, d, "body.png")),
	);
	let success = 0;
	for (const s of species) {
		if (await generateSpeciesAtlas(s)) success++;
	}
	console.log(`\nGenerated ${success}/${species.length} species atlases`);
} else {
	await generateSpeciesAtlas(speciesFlag);
}
