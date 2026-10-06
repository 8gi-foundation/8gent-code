/**
 * 8gent Code - what the images a command just wrote look like (#3580).
 *
 * In pilot run 2026-10-06_201120/media-brief-video the model drew five slide
 * PNGs with ImageMagick inside one `bash build.sh`. Its splitter left every
 * title blank and each body was one 40pt line wider than the 1280 px canvas,
 * cut off at both edges, so four slides looked almost the same. The command
 * printed "BUILD_OK" and the model never saw a pixel. This line puts the
 * images in front of it: how many were written, their size, and which ones
 * have content reaching an edge of a plain background.
 *
 * It is read-only and model-free: a bounded walk for image files modified
 * since the command started, then one small decode per image, all inside a
 * time budget. Any failure (no sharp, unreadable file, budget spent) drops the
 * line, never the command.
 *
 * "Written" means modified since the command started. A watcher, dev server
 * or another agent writing images in the same window is listed too; the line
 * is a pointer to look, not an audit.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SKIP_DIRS = new Set(["node_modules", "vendor"]);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 3000;
const MAX_IMAGES = 40;
const MAX_LISTED = 8;
/** Larger files are listed but not decoded. */
const MAX_DECODE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;
/** Total time the whole check may add to a command. */
const BUDGET_MS = 3000;
/** Grey levels two corners may differ by and still be one plain background. */
const CORNER_TOLERANCE = 10;
/** Grey levels a pixel must differ from the background by to count as drawn. */
const INK_THRESHOLD = 48;
/** A row or column this full of ink is a rule, stripe or border, not text. */
const LINE_FRACTION = 0.9;
const SAMPLE_WIDTH = 320;
/** Results that mean the command never ran. */
const REFUSED = /^\[(PERMISSION DENIED|BLOCKED|SYSTEM ONE BLOCKED|TOOLG8 BLOCKED)\]/;

type Side = "left" | "right" | "top" | "bottom";
type Found = { file: string; bytes: number };

/** Image files under `root` modified at or after `sinceMs`, in name order. */
export function imagesWrittenSince(root: string, sinceMs: number): Found[] {
	// Floor to the second: some filesystems keep whole-second mtimes.
	const since = Math.floor(sinceMs / 1000) * 1000;
	const found: Found[] = [];
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
			// Symlinks and FIFOs are neither, so the walk never leaves root.
			if (item.isDirectory()) {
				if (!SKIP_DIRS.has(item.name) && depth < MAX_DEPTH) subdirs.push(full);
			} else if (item.isFile() && IMAGE_EXTENSIONS.has(path.extname(item.name).toLowerCase())) {
				try {
					const st = fs.statSync(full);
					if (st.mtimeMs >= since) found.push({ file: full, bytes: st.size });
				} catch {}
			}
		}
		for (const sub of subdirs) walk(sub, depth + 1);
	};
	walk(root, 0);
	return found.sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
}

/**
 * Edges where drawn content meets the border of an image whose four corners
 * share one plain, opaque background. Photos and gradients (corners disagree)
 * and transparent artwork such as icons are never flagged. Rows or columns
 * that are almost all ink (dividers, accent stripes, borders) do not count:
 * cut-off text touches an edge in a broken run, not a solid line.
 */
export function clippedSides(px: Uint8Array | Buffer, width: number, height: number): Side[] {
	const at = (x: number, y: number) => px[y * width + x];
	const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
	if (Math.max(...corners) - Math.min(...corners) > CORNER_TOLERANCE) return [];
	const bg = corners.reduce((a, b) => a + b, 0) / 4;
	const ink = (x: number, y: number) => Math.abs(at(x, y) - bg) > INK_THRESHOLD;
	const rowIsLine = (y: number) => {
		let n = 0;
		for (let x = 0; x < width; x++) if (ink(x, y)) n++;
		return n >= LINE_FRACTION * width;
	};
	const colIsLine = (x: number) => {
		let n = 0;
		for (let y = 0; y < height; y++) if (ink(x, y)) n++;
		return n >= LINE_FRACTION * height;
	};
	const touchesColumn = (x: number) => {
		for (let y = 0; y < height; y++) if (ink(x, y) && !rowIsLine(y)) return true;
		return false;
	};
	const touchesRow = (y: number) => {
		for (let x = 0; x < width; x++) if (ink(x, y) && !colIsLine(x)) return true;
		return false;
	};
	const sides: Side[] = [];
	if (touchesColumn(0)) sides.push("left");
	if (touchesColumn(width - 1)) sides.push("right");
	if (touchesRow(0)) sides.push("top");
	if (touchesRow(height - 1)) sides.push("bottom");
	return sides;
}

function listNames(names: string[]): string {
	return names.length <= MAX_LISTED
		? names.join(", ")
		: `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more`;
}

/**
 * One line for a run_command result: the images the command wrote, and any
 * whose content reaches an edge. "" when it wrote no images.
 */
export async function imagesWrittenLine(
	workingDirectory: string,
	sinceMs: number,
): Promise<string> {
	const root = path.resolve(workingDirectory);
	// Never list a whole home or filesystem: unrelated files would reach the model.
	if (root === path.parse(root).root || root === homedir()) return "";
	const found = imagesWrittenSince(root, sinceMs);
	if (found.length === 0) return "";
	let sharp: typeof import("sharp") | null = null;
	try {
		sharp = (await import("sharp")).default;
	} catch {}
	const rel = (f: string) => path.relative(root, f) || f;
	const sizes = new Set<string>();
	const clipped: string[] = [];
	if (sharp) {
		for (const { file, bytes } of found) {
			if (bytes > MAX_DECODE_BYTES) continue;
			try {
				const { data, info } = await sharp(file, {
					limitInputPixels: MAX_INPUT_PIXELS,
					failOn: "error",
				})
					.resize({ width: SAMPLE_WIDTH, withoutEnlargement: true })
					.ensureAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
				const meta = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
				if (meta.width && meta.height) sizes.add(`${meta.width}x${meta.height}`);
				const { width, height } = info;
				const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];
				const transparent = [
					alphaAt(0, 0),
					alphaAt(width - 1, 0),
					alphaAt(0, height - 1),
					alphaAt(width - 1, height - 1),
				].some((a) => a < 250);
				if (transparent) continue;
				const grey = new Uint8Array(width * height);
				for (let i = 0; i < grey.length; i++)
					grey[i] = Math.round(
						0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2],
					);
				const sides = clippedSides(grey, width, height);
				if (sides.length > 0) clipped.push(`${rel(file)} (${sides.join(", ")})`);
			} catch {}
		}
	}
	const size = sizes.size === 1 ? ` (${[...sizes][0]})` : "";
	const parts = [
		`Images written: ${found.length}${size}: ${listNames(found.map((f) => rel(f.file)))}.`,
	];
	if (clipped.length > 0) {
		parts.push(
			`Content reaches the edge of a plain background in ${listNames(clipped)}; if that is text, it is cut off. Wrap or shrink it to fit, re-render, and check each image shows its own content.`,
		);
	}
	return parts.join(" ");
}

/**
 * A run_command result with the image line appended. Skipped when the
 * command was refused, and bounded by BUDGET_MS so it never stalls a turn.
 */
export async function withImagesWritten(
	output: string,
	workingDirectory: string,
	sinceMs: number,
): Promise<string> {
	if (REFUSED.test(output)) return output;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<string>((resolve) => {
		timer = setTimeout(() => resolve(""), BUDGET_MS);
		timer.unref?.();
	});
	const line = await Promise.race([
		imagesWrittenLine(workingDirectory, sinceMs).catch(() => ""),
		budget,
	]);
	clearTimeout(timer);
	return line ? `${output}\n${line}` : output;
}
