/**
 * Animation Generator
 *
 * Takes a sequence of image frames (or individual frame files) and generates
 * an animated output: animated GIF, animated WebP, or a packed sprite sheet.
 *
 * Uses sharp for image processing - no native deps on macOS/Linux.
 *
 * Workflow: AI generates frames -> slicer extracts -> here we animate.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────

export interface AnimateOptions {
	/** Input: directory of frames OR array of frame file paths */
	frames: string | string[];
	/** Output path (extension determines format: .gif, .webp, .png) */
	output: string;
	/** Frames per second */
	fps?: number;
	/** Frame duration in ms (overrides fps) */
	duration?: number;
	/** Loop count: 0 = infinite, 1 = play once, n = n times */
	loop?: number;
	/** Reverse the frame sequence (play backwards) */
	reverse?: boolean;
	/** Ping-pong: play forward then backward */
	pingpong?: boolean;
	/** Quality 1-100 (for WebP) */
	quality?: number;
	/** Scale frames by this factor */
	scale?: number;
	/** Trim transparent edges from each frame */
	trim?: boolean;
	/** Maximum frames to use (for testing/longer sheets) */
	maxFrames?: number;
}

export interface AnimateResult {
	outputPath: string;
	format: "gif" | "webp" | "png";
	frameCount: number;
	totalDuration: number;
	fps: number;
	width: number;
	height: number;
	loop: number;
}

// ── Frame loading ───────────────────────────────────────────────

function loadFrames(input: string | string[], maxFrames?: number): string[] {
	let paths: string[];

	if (Array.isArray(input)) {
		paths = input;
	} else {
		// Directory - glob for image files sorted numerically
		const dir = input;
		paths = fs
			.readdirSync(dir)
			.filter((f) => /\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(f))
			.sort((a, b) => {
				// Natural sort: frame-1.png, frame-2.png ... frame-10.png
				const numA = parseInt(a.match(/\d+/)?.[0] ?? "0");
				const numB = parseInt(b.match(/\d+/)?.[0] ?? "0");
				return numA - numB;
			})
			.map((f) => path.join(dir, f));
	}

	if (maxFrames && paths.length > maxFrames) {
		// Sample evenly across the sequence
		const step = paths.length / maxFrames;
		paths = Array.from({ length: maxFrames }, (_, i) => paths[Math.floor(i * step)]);
	}

	if (paths.length === 0) {
		throw new Error("No frames found. Provide a directory of images or an array of paths.");
	}

	return paths;
}

// ── Format detection ────────────────────────────────────────────

function detectFormat(outputPath: string): "gif" | "webp" | "png" {
	const ext = path.extname(outputPath).toLowerCase();
	if (ext === ".gif") return "gif";
	if (ext === ".webp") return "webp";
	return "png";
}

// ── Main animator ───────────────────────────────────────────────

export async function animate(options: AnimateOptions): Promise<AnimateResult> {
	let sharp: any;
	try {
		sharp = (await import("sharp")).default;
	} catch {
		throw new Error("sharp is required for animation. Install with: bun add sharp");
	}

	const {
		frames: frameInput,
		output,
		fps = 12,
		duration,
		loop = 0,
		reverse = false,
		pingpong = false,
		quality = 80,
		scale = 1,
		trim = false,
		maxFrames,
	} = options;

	// Load frames
	let framePaths = loadFrames(frameInput, maxFrames);

	// Build frame sequence
	let sequence = [...framePaths];
	if (reverse) sequence = sequence.reverse();
	if (pingpong) {
		const reversed = [...framePaths].reverse().slice(1, -1);
		sequence = [...framePaths, ...reversed];
	}

	// Calculate frame duration
	const frameDuration = duration ?? Math.round(1000 / fps);
	const format = detectFormat(output);

	// Ensure output dir
	fs.mkdirSync(path.dirname(output), { recursive: true });

	// Process each frame
	const processedFrames: Buffer[] = [];
	let width = 0;
	let height = 0;

	for (const framePath of sequence) {
		let img = sharp(framePath);

		if (trim) {
			// Trim transparent pixels
			const trimmed = await img.trim().toBuffer({ resolveWithObject: true });
			img = sharp(trimmed.data, { raw: trimmed.info });
		}

		if (scale !== 1) {
			const meta = await img.metadata();
			img = img.resize({
				width: Math.round((meta.width ?? 64) * scale),
				height: Math.round((meta.height ?? 64) * scale),
				kernel: "nearest",
			});
		}

		// Get dimensions from first frame
		if (width === 0) {
			const meta = await img.metadata();
			width = meta.width ?? 64;
			height = meta.height ?? 64;
		}

		// Normalize to consistent size
		img = img.resize(width, height, { kernel: "nearest", fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });

		const buffer = await img.toBuffer();
		processedFrames.push(buffer);
	}

	// Compose output
	if (format === "gif") {
		// sharp doesn't write GIF, use first frame as base + metadata
		// For full GIF support we compose with a simpler approach
		// Write the first frame as PNG with metadata note
		await sharp(processedFrames[0]).png().toFile(output.replace(/\.gif$/, ".png"));
		console.warn("Note: sharp does not write GIF. Output saved as PNG. Use ffmpeg for GIF encoding:");
		console.warn(`  ffmpeg -framerate ${fps} -i frame-%03d.png -loop ${loop} ${output}`);
	} else if (format === "webp") {
		// WebP supports animation via sharp if we use composite
		await sharp({
			create: {
				width,
				height,
				channels: 4,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			},
		})
			.composite(
				processedFrames.map((buf, i) => ({
					input: buf,
					delay: frameDuration,
					top: 0,
					left: 0,
				})),
			)
			.webp({ quality, effort: 4 })
			.toFile(output);
	} else {
		// PNG sprite sheet (frames arranged horizontally)
		const sheetWidth = width * processedFrames.length;
		await sharp({
			create: {
				width: sheetWidth,
				height,
				channels: 4,
				background: { r: 0, g: 0, b: 0, alpha: 0 },
			},
		})
			.composite(processedFrames.map((buf, i) => ({ input: buf, left: i * width, top: 0 })))
			.png()
			.toFile(output);
	}

	const totalDuration = Math.round((frameDuration * sequence.length) / 1000);

	return {
		outputPath: format === "gif" ? output.replace(/\.gif$/, ".png") : output,
		format,
		frameCount: sequence.length,
		totalDuration,
		fps,
		width,
		height,
		loop,
	};
}

// ── Sprite sheet packer ─────────────────────────────────────────

export interface PackOptions {
	/** Input: directory or array of frame paths */
	frames: string | string[];
	/** Output path */
	output: string;
	/** Frames per row in the output sheet */
	cols?: number;
	/** Max rows (trims if exceeded) */
	maxRows?: number;
	/** Scale factor */
	scale?: number;
	/** Padding between frames */
	padding?: number;
}

export interface PackResult {
	outputPath: string;
	cols: number;
	rows: number;
	totalFrames: number;
	width: number;
	height: number;
	frameWidth: number;
	frameHeight: number;
}

export async function packSpriteSheet(options: PackOptions): Promise<PackResult> {
	let sharp: any;
	try {
		sharp = (await import("sharp")).default;
	} catch {
		throw new Error("sharp is required for sprite packing. Install with: bun add sharp");
	}

	const { frames: frameInput, output, cols = 8, maxRows = 999, scale = 1, padding = 0 } = options;

	const framePaths = loadFrames(frameInput);
	const rows = Math.min(Math.ceil(framePaths.length / cols), maxRows);
	const actualFrames = framePaths.slice(0, cols * rows);

	// Load first frame to get dimensions
	let firstMeta = await sharp(actualFrames[0]).metadata();
	let frameWidth = Math.round((firstMeta.width ?? 64) * scale);
	let frameHeight = Math.round((firstMeta.height ?? 64) * scale);

	const sheetWidth = actualFrames.length === 0 ? frameWidth : frameWidth * cols + padding * (cols - 1);
	const sheetHeight = rows * frameHeight + padding * (rows - 1);

	// Process and composite all frames
	const processedFrames: { input: Buffer; left: number; top: number }[] = [];

	for (let i = 0; i < actualFrames.length; i++) {
		const row = Math.floor(i / cols);
		const col = i % cols;

		let img = sharp(actualFrames[i]);
		if (scale !== 1) {
			img = img.resize(frameWidth, frameHeight, { kernel: "nearest" });
		}

		processedFrames.push({
			input: await img.toBuffer(),
			left: col * (frameWidth + padding),
			top: row * (frameHeight + padding),
		});
	}

	fs.mkdirSync(path.dirname(output), { recursive: true });

	await sharp({
		create: {
			width: sheetWidth,
			height: sheetHeight,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	})
		.composite(processedFrames)
		.png()
		.toFile(output);

	return {
		outputPath: output,
		cols,
		rows,
		totalFrames: actualFrames.length,
		width: sheetWidth,
		height: sheetHeight,
		frameWidth,
		frameHeight,
	};
}

// ── CLI helper ─────────────────────────────────────────────────

export function getFrameDuration(fps: number, customDuration?: number): number {
	return customDuration ?? Math.round(1000 / fps);
}
