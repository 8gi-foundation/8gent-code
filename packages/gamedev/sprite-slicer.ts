/**
 * Sprite Sheet Slicer
 *
 * Takes a sprite sheet image and slices it into individual frame images.
 * Uses sharp for image processing - zero native deps on macOS/Linux.
 *
 * Supports:
 * - Fixed grid slicing (rows x cols)
 * - Auto-detection of grid dimensions from image size
 * - Padding/margin between sprites
 * - Output as individual PNGs or a JSON atlas
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────

export interface SliceOptions {
	/** Path to the sprite sheet image */
	input: string;
	/** Output directory for sliced frames */
	outputDir: string;
	/** Number of columns in the grid */
	cols?: number;
	/** Number of rows in the grid */
	rows?: number;
	/** Frame width in pixels (alternative to cols) */
	frameWidth?: number;
	/** Frame height in pixels (alternative to rows) */
	frameHeight?: number;
	/** Padding between frames in pixels */
	padding?: number;
	/** Margin around the sheet edge in pixels */
	margin?: number;
	/** Output filename prefix (default: "frame") */
	prefix?: string;
	/** Also generate a JSON atlas file */
	atlas?: boolean;
}

export interface SliceResult {
	frames: Array<{
		index: number;
		filename: string;
		x: number;
		y: number;
		width: number;
		height: number;
	}>;
	atlasPath?: string;
	totalFrames: number;
	sheetWidth: number;
	sheetHeight: number;
}

interface AtlasFrame {
	frame: { x: number; y: number; w: number; h: number };
	sourceSize: { w: number; h: number };
	spriteSourceSize: { x: number; y: number; w: number; h: number };
}

// ── Auto-detection ──────────────────────────────────────────────

/**
 * Detect likely grid dimensions from image dimensions.
 * Assumes square or near-square sprites (common for game assets).
 */
export function detectGrid(
	width: number,
	height: number,
): { cols: number; rows: number; frameWidth: number; frameHeight: number } {
	// Common sprite sizes to try
	const commonSizes = [16, 32, 48, 64, 96, 128, 256];

	// Find best fit for width
	let bestW = 0;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const size of commonSizes) {
		if (width % size === 0) {
			const cols = width / size;
			// Prefer sizes that give reasonable column counts (2-16)
			const score = Math.abs(cols - 8) + (cols < 2 || cols > 20 ? 100 : 0);
			if (score < bestScore) {
				bestScore = score;
				bestW = size;
			}
		}
	}

	// Fall back to square assumption
	if (!bestW) bestW = Math.floor(width / 4);

	let bestH = 0;
	bestScore = Number.POSITIVE_INFINITY;
	for (const size of commonSizes) {
		if (height % size === 0) {
			const rows = height / size;
			const score = Math.abs(rows - 4) + (rows < 1 || rows > 20 ? 100 : 0);
			if (score < bestScore) {
				bestScore = score;
				bestH = size;
			}
		}
	}

	if (!bestH) bestH = bestW; // Assume square

	return {
		cols: Math.floor(width / bestW),
		rows: Math.floor(height / bestH),
		frameWidth: bestW,
		frameHeight: bestH,
	};
}

// ── Slicer ──────────────────────────────────────────────────────

/**
 * Slice a sprite sheet into individual frame images.
 */
export async function sliceSpriteSheet(
	options: SliceOptions,
): Promise<SliceResult> {
	// Dynamic import - sharp may not be installed
	let sharp: any;
	try {
		sharp = (await import("sharp")).default;
	} catch {
		throw new Error(
			"sharp is required for sprite slicing. Install with: bun add sharp",
		);
	}

	const {
		input,
		outputDir,
		padding = 0,
		margin = 0,
		prefix = "frame",
		atlas = false,
	} = options;

	if (!fs.existsSync(input)) {
		throw new Error(`Sprite sheet not found: ${input}`);
	}

	// Get image dimensions
	const metadata = await sharp(input).metadata();
	const sheetWidth = metadata.width!;
	const sheetHeight = metadata.height!;

	// Determine frame dimensions
	let frameWidth: number;
	let frameHeight: number;
	let cols: number;
	let rows: number;

	if (options.frameWidth && options.frameHeight) {
		frameWidth = options.frameWidth;
		frameHeight = options.frameHeight;
		cols = Math.floor(
			(sheetWidth - 2 * margin + padding) / (frameWidth + padding),
		);
		rows = Math.floor(
			(sheetHeight - 2 * margin + padding) / (frameHeight + padding),
		);
	} else if (options.cols && options.rows) {
		cols = options.cols;
		rows = options.rows;
		frameWidth = Math.floor(
			(sheetWidth - 2 * margin - (cols - 1) * padding) / cols,
		);
		frameHeight = Math.floor(
			(sheetHeight - 2 * margin - (rows - 1) * padding) / rows,
		);
	} else {
		const detected = detectGrid(
			sheetWidth - 2 * margin,
			sheetHeight - 2 * margin,
		);
		cols = detected.cols;
		rows = detected.rows;
		frameWidth = detected.frameWidth;
		frameHeight = detected.frameHeight;
	}

	// Create output directory
	fs.mkdirSync(outputDir, { recursive: true });

	const frames: SliceResult["frames"] = [];
	const atlasFrames: Record<string, AtlasFrame> = {};

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const index = row * cols + col;
			const x = margin + col * (frameWidth + padding);
			const y = margin + row * (frameHeight + padding);

			// Skip if out of bounds
			if (x + frameWidth > sheetWidth || y + frameHeight > sheetHeight)
				continue;

			const filename = `${prefix}-${String(index).padStart(3, "0")}.png`;
			const outputPath = path.join(outputDir, filename);

			await sharp(input)
				.extract({ left: x, top: y, width: frameWidth, height: frameHeight })
				.png()
				.toFile(outputPath);

			frames.push({
				index,
				filename,
				x,
				y,
				width: frameWidth,
				height: frameHeight,
			});

			if (atlas) {
				atlasFrames[filename] = {
					frame: { x, y, w: frameWidth, h: frameHeight },
					sourceSize: { w: frameWidth, h: frameHeight },
					spriteSourceSize: { x: 0, y: 0, w: frameWidth, h: frameHeight },
				};
			}
		}
	}

	let atlasPath: string | undefined;
	if (atlas) {
		atlasPath = path.join(outputDir, `${prefix}-atlas.json`);
		const atlasData = {
			frames: atlasFrames,
			meta: {
				image: path.basename(input),
				size: { w: sheetWidth, h: sheetHeight },
				scale: 1,
				format: "RGBA8888",
			},
		};
		fs.writeFileSync(atlasPath, JSON.stringify(atlasData, null, 2));
	}

	return {
		frames,
		atlasPath,
		totalFrames: frames.length,
		sheetWidth,
		sheetHeight,
	};
}
