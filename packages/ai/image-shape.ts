/**
 * 8gent Code - what the images a command just wrote look like (#3580).
 *
 * In pilot run 2026-10-06_201120/media-brief-video the model drew five slide
 * PNGs with ImageMagick inside one `bash build.sh`. Its splitter left every
 * title blank and each body was one 40pt line wider than the 1280 px canvas,
 * cut off at both edges, so four slides looked almost the same. The command
 * printed "BUILD_OK" and the model never saw a pixel. This line puts the
 * images in front of it: how many were written, their size, and which ones
 * have drawn content running off an edge of a plain background.
 *
 * It is read-only and model-free: a bounded walk for image files modified
 * since the command started, then one small greyscale decode per image. Any
 * failure (no sharp, unreadable file) drops the check, never the command.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor"]);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 3000;
const MAX_IMAGES = 40;
const MAX_LISTED = 8;
/** Grey levels two corners may differ by and still be one plain background. */
const CORNER_TOLERANCE = 10;
/** Grey levels a pixel must differ from the background by to count as drawn. */
const INK_THRESHOLD = 48;
const SAMPLE_WIDTH = 320;

type Side = "left" | "right" | "top" | "bottom";

/** Image files under `root` modified at or after `sinceMs`, in name order. */
export function imagesWrittenSince(root: string, sinceMs: number): string[] {
	// Floor to the second: some filesystems keep whole-second mtimes.
	const since = Math.floor(sinceMs / 1000) * 1000;
	const found: string[] = [];
	let entries = 0;
	const walk = (dir: string, depth: number) => {
		let items: fs.Dirent[];
		try {
			items = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const subdirs: string[] = [];
		for (const item of items) {
			if (++entries > MAX_ENTRIES || found.length >= MAX_IMAGES) return;
			if (item.name.startsWith(".")) continue;
			const full = path.join(dir, item.name);
			if (item.isDirectory()) {
				if (!SKIP_DIRS.has(item.name) && depth < MAX_DEPTH) subdirs.push(full);
			} else if (item.isFile() && IMAGE_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
				try {
					if (fs.statSync(full).mtimeMs >= since) found.push(full);
				} catch {}
			}
		}
		for (const sub of subdirs) walk(sub, depth + 1);
	};
	walk(root, 0);
	return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Edges where drawn content meets the border of an image whose four corners
 * share one plain background. A photo, gradient or full-bleed bar has corners
 * that disagree, so it is never flagged.
 */
export function clippedSides(px: Uint8Array | Buffer, width: number, height: number): Side[] {
	const at = (x: number, y: number) => px[y * width + x];
	const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
	if (Math.max(...corners) - Math.min(...corners) > CORNER_TOLERANCE) return [];
	const bg = corners.reduce((a, b) => a + b, 0) / 4;
	const ink = (x: number, y: number) => Math.abs(at(x, y) - bg) > INK_THRESHOLD;
	const sides: Side[] = [];
	const column = (x: number) => {
		for (let y = 0; y < height; y++) if (ink(x, y)) return true;
		return false;
	};
	const row = (y: number) => {
		for (let x = 0; x < width; x++) if (ink(x, y)) return true;
		return false;
	};
	if (column(0)) sides.push("left");
	if (column(width - 1)) sides.push("right");
	if (row(0)) sides.push("top");
	if (row(height - 1)) sides.push("bottom");
	return sides;
}

function joinSides(sides: Side[]): string {
	return sides.length === 1
		? `the ${sides[0]} edge`
		: `the ${sides.slice(0, -1).join(", ")} and ${sides.at(-1)} edges`;
}

function listNames(names: string[]): string {
	return names.length <= MAX_LISTED
		? names.join(", ")
		: `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more`;
}

/**
 * One line for a run_command result: the images the command wrote, and any
 * whose content runs off an edge. "" when it wrote no images.
 */
export async function imagesWrittenLine(
	workingDirectory: string,
	sinceMs: number,
): Promise<string> {
	const files = imagesWrittenSince(workingDirectory, sinceMs);
	if (files.length === 0) return "";
	let sharp: typeof import("sharp") | null = null;
	try {
		sharp = (await import("sharp")).default;
	} catch {}
	const rel = (f: string) => path.relative(workingDirectory, f) || f;
	const sizes = new Set<string>();
	const clipped: string[] = [];
	const clippedAt = new Set<Side>();
	if (sharp) {
		for (const file of files) {
			try {
				const meta = await sharp(file).metadata();
				if (meta.width && meta.height) sizes.add(`${meta.width}x${meta.height}`);
				const { data, info } = await sharp(file)
					.flatten({ background: "#000000" })
					.greyscale()
					.resize({ width: SAMPLE_WIDTH, withoutEnlargement: true })
					.raw()
					.toBuffer({ resolveWithObject: true });
				const sides = clippedSides(data, info.width, info.height);
				if (sides.length > 0) {
					clipped.push(rel(file));
					for (const side of sides) clippedAt.add(side);
				}
			} catch {}
		}
	}
	const size = sizes.size === 1 ? ` (${[...sizes][0]})` : "";
	const parts = [`Images written: ${files.length}${size}: ${listNames(files.map(rel))}.`];
	if (clipped.length > 0) {
		const where = (["left", "right", "top", "bottom"] as Side[]).filter((s) => clippedAt.has(s));
		parts.push(
			`${listNames(clipped)}: drawn content runs off ${joinSides(where)}, so text there is probably cut off. Wrap or shrink it to fit, re-render, and check each image shows its own content.`,
		);
	}
	return parts.join(" ");
}
