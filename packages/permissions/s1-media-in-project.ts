/**
 * System One passes a plain `magick` drawing call or `ffprobe` read without the
 * model judge when every file it touches is the workspace's own (#3948).
 *
 * Why: the Selene judge answered "escalate" to slide-drawing `magick -annotate`
 * and to `ffprobe` on the film. With no person to ask (pilot, headless) that is
 * a refusal, so media-brief-video lost runs to judge noise.
 *
 * Needs the caller's working directory (file checks hit the disk). Default mode
 * only, wired in system-one-gate.ts. A command passes only when ALL hold:
 *   - one command, no pipe, redirect, `;`, `&`, `$`, backtick or newline; the
 *     rules and the prompt-control check pass; no secret name; at most 80 words
 *     of at most 400 characters;
 *   - every option is on the lists below, with its value checked by kind;
 *   - every file read is a relative path inside the workspace, no `..`, no dot
 *     directory, an existing regular file that is not a symlink, none of its
 *     parents a symlink, and (magick) a raster image or a font file;
 *   - ffprobe's one input has no `:` `,` or `|` (subfile, concat, lavfi);
 *   - magick's last argument is a NEW raster image file: it must not exist (a
 *     dangling link counts), nothing on its path is a symlink or a dot
 *     directory, its parent is inside the workspace, and it is not a protected
 *     path. It can never overwrite code or an existing file;
 *   - -draw is a point, line, rectangle, circle, ellipse, polygon or text
 *     primitive with no `image`, `@`, `:`, `/` or `%`; annotate, label and
 *     caption text carry no leading `@` and no `%` escape (`%[`, `%f`, `%d`),
 *     which would print a file's name or metadata into the picture;
 *   - no scheme or URL anywhere except the pure generators (xc:, canvas:,
 *     caption:, label:, gradient:, radial-gradient:, plasma:, null:, pattern:);
 *     no -write, -script, -define, -profile, svg, mvg or msl.
 * Sizes and probe windows are capped. Anything else goes to the judge as before.
 *
 * TOCTOU (accepted, same as s1-rm-single.ts): a path can change between this
 * check and the spawn. Synchronous, never throws.
 */

import { lstatSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules, maskQuotes, shellWords, splitSegments } from "../decide/rules";
import { protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { SECRET, canon, symlinkBelow } from "./s1-run-in-project";

export type MediaInProject = { ok: true; reason: string } | { ok: false };
const NO: MediaInProject = { ok: false };

const MAX_WORDS = 80;
const MAX_WORD_LEN = 400;
const MAX_DIM = 8192;
const OPTION = /^[-+][a-zA-Z]/;
const RASTER = /\.(png|jpe?g|gif|webp|bmp|tiff?|ppm|pgm|pbm)$/i;
const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9_-]*:/;
const PERCENT_ESCAPE = /%[[a-zA-Z@%]/;
const DRAW = /^(point|line|rectangle|roundrectangle|circle|ellipse|polygon|text)\s/i;

const MAGICK_BOOL = new Set([
	"strip", "negate", "normalize", "flatten", "append", "flip", "flop", "monochrome", "auto-orient", "coalesce", "trim",
	"composite",
]);
const MAGICK_PLUS_BOOL = new Set(["repage", "append", "gravity", "antialias", "dither"]);
const MAGICK_TEXT = new Set(["label", "caption"]);
const MAGICK_SIZED = new Set(["size", "resize", "scale", "extent", "thumbnail", "crop", "geometry", "density", "border", "shave", "splice"]);
const MAGICK_VALUE = new Set([
	"fill", "stroke", "strokewidth", "pointsize", "gravity", "background", "bordercolor", "colorspace", "depth", "quality",
	"rotate", "blur", "sharpen", "gaussian-blur", "compose", "alpha", "antialias", "kerning", "interline-spacing",
	"interword-spacing", "undercolor", "repage", "shadow", "vignette", "unsharp", "modulate", "level",
	"brightness-contrast", "gamma", "sepia-tone", "roll", "fuzz", "transparent", "opaque", "delay", "loop", "layers",
	"colors", "dither", "type", "units", "page", "text-encoding", "family", "style", "weight", "stretch", "virtual-pixel",
	"filter", "sampling-factor", "interlace", "orient",
]);
const GENERATORS = new Set(["xc", "canvas", "caption", "label", "gradient", "radial-gradient", "plasma", "null", "pattern"]);

const FFPROBE_BOOL = new Set([
	"hide_banner", "show_format", "show_streams", "count_frames", "count_packets", "sexagesimal", "pretty", "show_chapters",
	"show_programs", "show_packets", "show_frames", "show_error", "bitexact", "byte_binary_prefix",
]);

interface Ctx {
	root: string;
}

function lstatOrNull(p: string) {
	return lstatSync(p, { throwIfNoEntry: false }) ?? null;
}

/** Lexical checks shared by reads and the new output; returns the absolute path or null. */
function workspacePath(p: string, cx: Ctx): { abs: string; rel: string } | null {
	if (!p || /^[/~-]/.test(p) || /[*?[\]{}$]/.test(p) || SECRET.test(p)) return null;
	if (p.split("/").includes("..")) return null;
	const lexical = path.resolve(cx.root, p);
	const abs = canon(lexical);
	if (!inside(abs, cx.root) || !inside(lexical, cx.root)) return null;
	const rel = path.relative(cx.root, lexical);
	if (rel === "" || SECRET.test(rel) || protectedRel(rel)) return null;
	const segs = rel.split("/");
	if (segs.some((s) => s.startsWith(".")) || segs.includes("node_modules")) return null;
	if (symlinkBelow(cx.root, lexical)) return null;
	return { abs: lexical, rel };
}

/** An existing regular file, not a symlink, inside the workspace. */
function readableFile(p: string, cx: Ctx): boolean {
	const w = workspacePath(p, cx);
	if (!w) return false;
	const st = lstatOrNull(w.abs);
	return !!st && st.isFile() && !st.isSymbolicLink();
}

/** A raster path that does not exist yet, whose parent is a real directory in the workspace. */
function newImage(p: string, cx: Ctx): boolean {
	if (!RASTER.test(p) || SCHEME.test(p)) return false;
	const w = workspacePath(p, cx);
	if (!w || lstatOrNull(w.abs)) return false; // exists, or a dangling link
	const parent = path.dirname(w.abs);
	if (parent !== cx.root) {
		const pst = lstatOrNull(parent);
		if (!pst || !pst.isDirectory() || pst.isSymbolicLink()) return false;
	}
	return true;
}

function textOk(v: string): boolean {
	return !v.startsWith("@") && !PERCENT_ESCAPE.test(v) && !v.includes("://");
}

function sizedOk(v: string): boolean {
	if (!/^[0-9x+%!<>^@.,-]*$/i.test(v) || v.includes("@")) return false;
	return (v.match(/\d+/g) ?? []).every((n) => Number(n) <= MAX_DIM);
}

function generatorOk(a: string): boolean {
	const colon = a.indexOf(":");
	const name = a.slice(0, colon).toLowerCase();
	if (!GENERATORS.has(name)) return false;
	const val = a.slice(colon + 1);
	if (name === "caption" || name === "label") return textOk(val);
	return !val.startsWith("@") && !val.includes("/") && !val.includes("://");
}

function magickOk(args: string[], cx: Ctx): boolean {
	if (args.length < 2) return false;
	let i = 0;
	let outputIndex = -1;
	const value = (): string | null => (i + 1 < args.length ? args[++i] : null);
	for (; i < args.length; i++) {
		const a = args[i];
		if (OPTION.test(a)) {
			const name = a.slice(1);
			if (a.startsWith("+")) {
				if (!MAGICK_PLUS_BOOL.has(name)) return false;
				continue;
			}
			if (MAGICK_BOOL.has(name)) continue;
			if (name === "annotate") {
				const geo = value();
				const text = value();
				if (geo === null || text === null || !/^[0-9x+-]+$/.test(geo) || !textOk(text)) return false;
			} else if (name === "draw") {
				const v = value();
				if (v === null || !DRAW.test(v) || /image|[@:/%]/i.test(v)) return false;
			} else if (MAGICK_TEXT.has(name)) {
				const v = value();
				if (v === null || !textOk(v)) return false;
			} else if (name === "font") {
				const v = value();
				if (v === null || v.startsWith("@") || SCHEME.test(v)) return false;
				if (v.includes("/") || v.includes(".")) {
					if (!FONT_FILE.test(v) || !readableFile(v, cx)) return false;
				}
			} else if (name === "tile") {
				const v = value();
				if (v === null || !RASTER.test(v) || !readableFile(v, cx)) return false;
			} else if (MAGICK_SIZED.has(name)) {
				const v = value();
				if (v === null || !sizedOk(v)) return false;
			} else if (MAGICK_VALUE.has(name)) {
				const v = value();
				if (v === null || v.startsWith("@") || SCHEME.test(v) || v.includes("/") || PERCENT_ESCAPE.test(v)) return false;
			} else return false;
			continue;
		}
		// A bare argument: a pure generator, or an existing workspace image, or (last) the new output.
		if (SCHEME.test(a)) {
			if (!generatorOk(a)) return false;
			continue;
		}
		if (i === args.length - 1) {
			if (!newImage(a, cx)) return false;
			outputIndex = i;
			continue;
		}
		if (!RASTER.test(a) || !readableFile(a, cx)) return false;
	}
	return outputIndex === args.length - 1;
}

function ffprobeOk(args: string[], cx: Ctx): boolean {
	let input: string | null = null;
	const take = (p: string): boolean => {
		if (input !== null || /[:,|]/.test(p) || !readableFile(p, cx)) return false;
		input = p;
		return true;
	};
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!OPTION.test(a)) {
			if (!take(a)) return false;
			continue;
		}
		if (a.startsWith("+")) return false;
		const name = a.slice(1);
		if (FFPROBE_BOOL.has(name)) continue;
		const v = args[++i];
		if (v === undefined) return false;
		switch (name) {
			case "i":
				if (!take(v)) return false;
				break;
			case "v":
			case "loglevel":
				if (!/^(quiet|panic|fatal|error|warning|info|verbose|debug|-?\d{1,2})$/.test(v)) return false;
				break;
			case "select_streams":
				if (!/^[avsdt]?(:\d{1,3})?$/.test(v)) return false;
				break;
			case "show_entries":
			case "of":
			case "print_format":
				if (!/^[A-Za-z0-9_=,:.|-]+$/.test(v)) return false;
				break;
			case "analyzeduration":
			case "probesize":
				if (!/^\d{1,9}$/.test(v) || Number(v) > 100_000_000) return false;
				break;
			default:
				return false;
		}
	}
	return input !== null;
}

/** ok when `command` is a plain magick drawing call or ffprobe read on the workspace's own files. */
export function mediaInProject(command: string, cwd: string | undefined): MediaInProject {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!/^(magick|ffprobe) /.test(text) || promptControlText(text) !== null) return NO;
		if (/[$`\n\r]/.test(text) || SECRET.test(text)) return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const { segs, subs } = splitSegments(text);
		if (segs.length !== 1 || subs.length) return NO;
		if (/[<>|&;()]/.test(maskQuotes(text))) return NO;
		const words = shellWords(text);
		if (!words || words.length < 2 || words.length > MAX_WORDS || words.some((w) => w.length > MAX_WORD_LEN)) return NO;
		const cx: Ctx = { root: canon(cwd) };
		const [bin, ...args] = words;
		if (bin === "magick") return magickOk(args, cx) ? { ok: true, reason: "magick drawing a new image from workspace files" } : NO;
		if (bin === "ffprobe") return ffprobeOk(args, cx) ? { ok: true, reason: "ffprobe reading one workspace file" } : NO;
		return NO;
	} catch {
		return NO;
	}
}
