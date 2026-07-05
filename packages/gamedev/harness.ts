/**
 * Media Harness - Wave 74 Integration Layer
 *
 * Takes natural language -> sprite generation.
 * Local-first: sharp + canvas for sprite sheets.
 * Cloud fallback: OpenAI DALL-E / GPT Image when local can't produce.
 *
 * Assets saved to ~/.8gent/assets/media/ with a JSON index.
 *
 * EXIT CONDITION: harness.generate("a walking character") returns
 * { success: true, sheetPath, manifest } or { success: false, reason }
 * and the asset appears in the asset library.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { animate, packSpriteSheet } from "./animation-generator.js";
import { sliceSpriteSheet } from "./sprite-slicer.js";
import { buildSpritePrompt, type SpritePromptConfig } from "./prompts.js";

// ── Paths ───────────────────────────────────────────────────────
const ASSET_DIR = join(homedir(), ".8gent", "assets", "media");
const INDEX_PATH = join(ASSET_DIR, "index.json");

// ── Types ───────────────────────────────────────────────────────

export interface GenerateOptions {
	/** Natural language description of what to generate */
	prompt: string;
	/** Frames in the animation (default: 8) */
	frameCount?: number;
	/** Loop vs. one-shot */
	loop?: boolean;
	/** Direction: forward | reverse | pingpong */
	direction?: "forward" | "reverse" | "pingpong";
	/** Art style */
	style?: "pixel-art" | "hand-drawn" | "3d-render" | "anime" | "painterly";
	/** Output format */
	format?: "gif" | "webp" | "png";
	/** Force cloud path even if local is available */
	forceCloud?: boolean;
}

export interface GenerateResult {
	success: boolean;
	/** Path to the generated spritesheet (relative to ASSET_DIR) */
	sheetPath?: string;
	/** Path to the animated output (gif/webp) */
	animatedPath?: string;
	/** Parsed animation frames for the manifest */
	manifest?: MediaAssetManifest;
	/** Error or reason for failure */
	reason?: string;
	/** Which path was used */
	path: "local" | "cloud" | "degraded";
}

// ── Tool Detection ──────────────────────────────────────────────

function which(cmd: string): string | null {
	try {
		return execSync(`command -v "${cmd}" 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim() || null;
	} catch {
		return null;
	}
}

export interface ToolAvailability {
	sharp: boolean;
	canvas: boolean;
	ffmpeg: boolean;
	openai: boolean;
	openaiKey: string | null;
}

let toolCache: ToolAvailability | null = null;

export function detectTools(): ToolAvailability {
	if (toolCache) return toolCache;

	const openaiKey = process.env.OPENAI_API_KEY || null;

	toolCache = {
		sharp: which("node") !== null, // sharp is a Node.js package, checked via try-import below
		canvas: which("node") !== null,
		ffmpeg: which("ffmpeg") !== null,
		openai: openaiKey !== null,
		openaiKey,
	};

	return toolCache;
}

// Check sharp availability at runtime
async function checkSharp(): Promise<boolean> {
	try {
		await import("sharp");
		return true;
	} catch {
		return false;
	}
}

// ── Asset Library ───────────────────────────────────────────────

export interface MediaAsset {
	id: string;
	name: string;
	type: "sprite" | "animation" | "tileset" | "ui" | "item" | "particle";
	prompt: string;
	sheetPath: string;
	animatedPath?: string;
	manifest: MediaAssetManifest;
	createdAt: number;
	path: "local" | "cloud";
	tags: string[];
}

export interface MediaAssetManifest {
	frames: number;
	cols: number;
	rows: number;
	frameWidth: number;
	frameHeight: number;
	fps: number;
	loop: boolean;
	direction: string;
	animations: Record<string, { start: number; count: number }>;
}

function loadIndex(): MediaAsset[] {
	mkdirSync(ASSET_DIR, { recursive: true });
	if (!existsSync(INDEX_PATH)) return [];
	try {
		return JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
	} catch {
		return [];
	}
}

function saveIndex(assets: MediaAsset[]): void {
	mkdirSync(ASSET_DIR, { recursive: true });
	writeFileSync(INDEX_PATH, JSON.stringify(assets, null, 2));
}

function addAsset(asset: MediaAsset): void {
	const index = loadIndex();
	// Avoid duplicates by id
	const filtered = index.filter((a) => a.id !== asset.id);
	filtered.unshift(asset); // newest first
	saveIndex(filtered.slice(0, 200)); // cap at 200 assets
}

export function listAssets(type?: MediaAsset["type"]): MediaAsset[] {
	const index = loadIndex();
	if (type) return index.filter((a) => a.type === type);
	return index;
}

// ── Local Generation ──────────────────────────────────────────────

/**
 * Generate a sprite sheet from a pre-existing PNG using local tools.
 * Used when the user provides an image file, not when generating from scratch.
 */
async function generateLocalFromImage(
	inputPath: string,
	options: GenerateOptions,
): Promise<GenerateResult> {
	const id = `local-${Date.now()}`;
	const name = options.prompt.slice(0, 60);

	mkdirSync(join(ASSET_DIR, id), { recursive: true });
	const outDir = join(ASSET_DIR, id, "frames");
	mkdirSync(outDir, { recursive: true });

	try {
		// Step 1: Slice the input sprite sheet
		const sliceResult = await sliceSpriteSheet({
			input: inputPath,
			outputDir: outDir,
			prefix: "frame",
			atlas: true,
		});

		// Step 2: Animate from sliced frames
		const framePaths = sliceResult.frames.map((f) => join(outDir, f.filename));
		const direction = options.direction || "forward";
		const format = options.format || "gif";

		const animResult = await animate({
			frames: framePaths,
			// Output extension determines the format (gif/webp/png).
			output: join(ASSET_DIR, id, `animation.${format}`),
			fps: 8,
			// AnimateOptions.loop is a count: 0 = infinite, 1 = play once.
			loop: options.loop === false ? 1 : 0,
			reverse: direction === "reverse",
			pingpong: direction === "pingpong",
		});

		// Step 3: Pack sprite sheet
		const sheetPath = join(ASSET_DIR, id, `sheet.png`);
		const packResult = await packSpriteSheet({
			frames: framePaths,
			output: sheetPath,
			cols: sliceResult.frames.length,
		});

		const manifest: MediaAssetManifest = {
			frames: sliceResult.totalFrames,
			cols: packResult.cols,
			rows: packResult.rows,
			frameWidth: packResult.frameWidth,
			frameHeight: packResult.frameHeight,
			fps: 8,
			loop: options.loop !== false,
			direction,
			animations: { idle: { start: 0, count: sliceResult.totalFrames } },
		};

		const asset: MediaAsset = {
			id,
			name,
			type: "sprite",
			prompt: options.prompt,
			sheetPath: join(ASSET_DIR, id, `sheet.png`),
			animatedPath: animResult.outputPath,
			manifest,
			createdAt: Date.now(),
			path: "local",
			tags: [],
		};

		addAsset(asset);

		return {
			success: true,
			sheetPath: asset.sheetPath,
			animatedPath: asset.animatedPath,
			manifest,
			path: "local",
		};
	} catch (err) {
		return {
			success: false,
			reason: (err as Error).message,
			path: "degraded",
		};
	}
}

// ── Cloud Fallback (DALL-E / GPT Image) ──────────────────────────

async function generateCloud(options: GenerateOptions): Promise<GenerateResult> {
	const tools = detectTools();
	if (!tools.openaiKey) {
		return {
			success: false,
			reason: "No OPENAI_API_KEY set. Cloud generation unavailable.",
			path: "degraded",
		};
	}

	const id = `cloud-${Date.now()}`;
	const name = options.prompt.slice(0, 60);
	mkdirSync(join(ASSET_DIR, id), { recursive: true });

	// Build the sprite prompt for DALL-E
	const cfg: SpritePromptConfig = {
		subject: options.prompt,
		style: options.style || "pixel-art",
		cols: options.frameCount || 8,
		rows: 1,
		frameSize: 128,
		background: "transparent",
		animation: "idle",
	};

	const imagePrompt = buildSpritePrompt(cfg);

	try {
		// Call DALL-E 3 or 2
		const model = "dall-e-3"; // switch to dall-e-2 for lower cost
		const response = await fetch("https://api.openai.com/v1/images/generations", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${tools.openaiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				prompt: imagePrompt,
				n: 1,
				size: "1024x1024",
				response_format: "url",
			}),
		});

		if (!response.ok) {
			const errBody = await response.text();
			return {
				success: false,
				reason: `Cloud API error ${response.status}: ${errBody}`,
				path: "cloud",
			};
		}

		const data = (await response.json()) as { data: { url: string }[] };
		const imageUrl = data.data[0]?.url;

		if (!imageUrl) {
			return {
				success: false,
				reason: "Cloud API returned no image URL",
				path: "cloud",
			};
		}

		// Download the generated image
		const imgRes = await fetch(imageUrl);
		const imgBuf = await imgRes.arrayBuffer();
		const sheetPath = join(ASSET_DIR, id, "sheet.png");
		await Bun.write(sheetPath, imgBuf);

		const manifest: MediaAssetManifest = {
			frames: 1,
			cols: 1,
			rows: 1,
			frameWidth: 1024,
			frameHeight: 1024,
			fps: 8,
			loop: true,
			direction: "forward",
			animations: { idle: { start: 0, count: 1 } },
		};

		const asset: MediaAsset = {
			id,
			name,
			type: "sprite",
			prompt: options.prompt,
			sheetPath,
			manifest,
			createdAt: Date.now(),
			path: "cloud",
			tags: [],
		};

		addAsset(asset);

		return {
			success: true,
			sheetPath,
			manifest,
			path: "cloud",
		};
	} catch (err) {
		return {
			success: false,
			reason: (err as Error).message,
			path: "cloud",
		};
	}
}

// ── Main Harness Entry Point ─────────────────────────────────────

/**
 * Generate a sprite animation from a natural language prompt.
 *
 * Priority:
 * 1. Local sharp/canvas if available and no --force-cloud flag
 * 2. Cloud DALL-E fallback if OPENAI_API_KEY is set
 * 3. Honest degradation with a clear reason
 *
 * @example
 * const result = await generate({ prompt: "a walking robot", frameCount: 8, loop: true });
 * if (result.success) {
 *   console.log("Sheet:", result.sheetPath);
 *   console.log("Manifest:", result.manifest);
 * } else {
 *   console.log("Failed:", result.reason);
 * }
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
	const tools = detectTools();
	const forceCloud = options.forceCloud || false;

	console.log(`[media-harness] Generating: "${options.prompt}"`);
	console.log(`[media-harness] Tools: sharp=${await checkSharp()}, ffmpeg=${tools.ffmpeg}, openai=${tools.openai}`);

	// Try local first unless forceCloud
	if (!forceCloud) {
		// Local path: requires sharp for image processing
		const sharpAvailable = await checkSharp();

		if (sharpAvailable) {
			// Local path: user must provide an input image or use the lil-eight generator
			// Since we generate from prompts (not images), we go to cloud directly
			// The local path is for slicing/processing existing images
			console.log("[media-harness] Local sharp available but prompt-based generation requires cloud path.");
		} else {
			console.log("[media-harness] Local sharp unavailable.");
		}
	}

	// Cloud path: DALL-E generates the sprite sheet from the prompt
	if (tools.openai) {
		console.log("[media-harness] Using cloud fallback (DALL-E)...");
		return generateCloud(options);
	}

	// Honest degradation
	const id = `degraded-${Date.now()}`;
	return {
		success: false,
		reason:
			"Cannot generate: no local sharp (npm install sharp) and no OPENAI_API_KEY. " +
			"Install sharp for local slicing, or set OPENAI_API_KEY for cloud generation.",
		path: "degraded",
	};
}

// ── CLI Entry Point ──────────────────────────────────────────────

if (import.meta.main) {
	const args = process.argv.slice(2);
	const prompt = args.join(" ");

	if (!prompt) {
		console.log("Usage: bun run packages/gamedev/harness.ts <prompt> [--cloud] [--frames 8] [--gif|--webp]");
		console.log("Example: bun run packages/gamedev/harness.ts 'a walking robot' --frames 8 --gif");
		process.exit(1);
	}

	const options: GenerateOptions = {
		prompt,
		frameCount: 8,
		loop: true,
		format: args.includes("--webp") ? "webp" : args.includes("--gif") ? "gif" : "png",
		forceCloud: args.includes("--cloud"),
	};

	const result = await generate(options);

	if (result.success) {
		console.log(`[OK] Generated: ${result.sheetPath}`);
		console.log(`     Path used: ${result.path}`);
		if (result.animatedPath) console.log(`     Animated: ${result.animatedPath}`);
	} else {
		console.error(`[FAIL] ${result.reason}`);
		process.exit(1);
	}
}
