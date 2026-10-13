/**
 * System One: a plain `magick` or `convert` render, drawn from built-in generators, to an image
 * file inside the workspace (#4177; 8SO ruling in #4176).
 *
 * Real task artale-overnight (13 Oct 2026): seven single `magick` commands that drew slide frames
 * from `gradient:`, `xc:` and `caption:` into .tmp/overnight/frames inside the working directory
 * reached the judge (Selene 8B) and were blocked or escalated at pYes 0.35 to 0.43. Nothing in
 * them read outside the workspace, touched the network or deleted anything. The judge cannot tell
 * a long `-draw` list from an attack, so this lane reads the command instead. Same design as
 * s1-deck-render.ts: an ALLOWLIST of one shape, checked before the judge, default mode only. Any
 * command it does not fully understand is "no opinion" and goes to the rules and the judge as
 * before; this lane never denies.
 *
 * ok needs ALL of:
 *   - a working directory, absolute; not win32 (the grammar below is POSIX);
 *   - printable ASCII only; no `@` anywhere (an `@file` list, `label:@`, `caption:@`, `text:@`,
 *     `pango:@`, `-annotate ... @file` all read an arbitrary file); no `$` or backtick anywhere
 *     (no expansion, so no in-command variable); outside quotes only letters, digits,
 *     `_ . / + , = : % -`, spaces and the two escapes `\(` `\)`; inside double quotes no `\` or
 *     `!`;
 *   - the first word is exactly `magick` or `convert`; no env prefix;
 *   - every option is in OPTIONS below with each argument passing its validator (colors, numbers,
 *     geometry, plain names, a font NAME with no `/` that is not also an entry of the working
 *     directory (ImageMagick opens such a name as a font file), a `-draw` of one shape primitive with numeric
 *     points only, so no `image` primitive, no `text`, no `url(...)`); anything else (`-script`,
 *     `-read`, `-define`, `-set`, `-limit`, `-policy`, `-debug`, `-log`, `-monitor`,
 *     `-authenticate`, `-tile`, `-texture`, `-profile`, `-fx`, `-format`, `-print`, `-path`,
 *     `-delegate`, ...) is no opinion;
 *   - every image the command reads is a built-in generator from GENERATORS (`xc:`, `canvas:`,
 *     `gradient:`, `radial-gradient:`, `pattern:`, `plasma:`, `label:`, `caption:`) with a value
 *     that passes its validator. No file is read at all: a workspace file named .png can hold MVG,
 *     SVG or MSL (ImageTragick), and a write_file in the same step can swap it after this check.
 *     So every other coder is no opinion, among them `msl:`, `mvg:`, `svg:`, `msvg:`, `rsvg:`,
 *     `url:`, `http:`, `https:`, `ftp:`, `file:`, `ephemeral:` and `tmp:` (read then delete),
 *     `text:`, `txt:`, `inline:`, `pango:`, `fd:`, `vid:`, `x:`, `screenshot:`, `clipboard:`,
 *     `print:`, `show:`, `win:`, `ps:`, `eps:`, `pdf:` (Ghostscript), `info:`, `mpr:`;
 *   - the output (the last word) and every `-write`/`+write` target is a path with no coder prefix
 *     (no `:`), no `%`, no glob character or `~` (ImageMagick globs a quoted `'*.png'` itself), ending .png, .jpg, .jpeg, .webp or .gif, that resolves inside the working
 *     directory through the workspace boundary resolver (checkPath: realpath of the nearest
 *     existing ancestor, so an existing symlinked folder is followed), has no dot segment in the
 *     project other than `.tmp`, no symlink among its existing ancestors below the working
 *     directory (a dangling link the resolver cannot follow), is absent or a regular file that is
 *     not a symlink and has one link (a hardlink to a file outside would be overwritten in place),
 *     and is not a protected name or under a protected prefix of the project. After a
 *     `cd <folder> &&` the output stays inside that folder, as in the deck-render lane, and the
 *     dot and protected rules read the path from the project root, so the cd form and the root
 *     form agree. Every other token on the line is a number, color, name, font name, shape or
 *     text, never a path;
 *   - every PATH entry is absolute and resolves outside the working directory and the project
 *     (pathOutsideWorkspace, shared with the deck-render and tg-notify lanes): the `magick` that
 *     runs cannot be one the workspace planted;
 *   - no MAGICK_* variable and no FONTCONFIG_* variable; $HOME/.config/ImageMagick,
 *     $HOME/.magick, $XDG_CONFIG_HOME/ImageMagick and the per-user fontconfig configuration and
 *     font folders (when set) resolve outside the roots; and
 *     neither root holds an ImageMagick configuration file of its own name (CONFIG_NAMES), which
 *     some builds read from the current directory. So ImageMagick's policy.xml, delegates.xml
 *     (a command per format) and type.xml cannot come from the workspace.
 *
 * TODO(#4176): the in-line variable case (`D=...; magick ... "$D/x.png"`) is refused here by the `$`
 * rule; when #4176 lands checkPath's resolver tightens with it and the skipped probe turns on.
 *
 * Known window, same as the sibling lanes: a process of this uid could swap the output's folder for
 * a symlink between this check and the spawn. Accepted: an existing regular image file in the
 * workspace may be overwritten (re-rendering a frame), as the deck-render lane allows for its mp4.
 *
 * Synchronous, never throws.
 */

import * as path from "node:path";
import { pathOutsideWorkspace } from "./s1-deck-render";
import { lstatOrNull, protectedName, protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { checkPath, resolveSafe } from "./src/workspace-boundary";

export type MagickRender = { ok: true; reason: string } | { ok: false };

const NO: MagickRender = { ok: false };

/** Characters allowed outside quotes. `\(` and `\)` are handled before this test. */
const UNQUOTED = /^[A-Za-z0-9_./+,=:%-]$/;

/**
 * POSIX words of `text` under a strict grammar, or null (no opinion). Single quotes are literal;
 * double quotes may not hold `\` or `!` (`$` and backtick are refused for the whole line before);
 * outside quotes only UNQUOTED characters, spaces, and `\(` / `\)`.
 */
export function strictWords(text: string): string[] | null {
	const out: string[] = [];
	let tok = "";
	let has = false;
	for (let i = 0; i < text.length; ) {
		const c = text[i];
		if (c === " ") {
			if (has) out.push(tok);
			tok = "";
			has = false;
			i++;
		} else if (c === "'") {
			const j = text.indexOf("'", i + 1);
			if (j < 0) return null;
			tok += text.slice(i + 1, j);
			has = true;
			i = j + 1;
		} else if (c === '"') {
			const j = text.indexOf('"', i + 1);
			if (j < 0) return null;
			const body = text.slice(i + 1, j);
			if (/[\\!]/.test(body)) return null;
			tok += body;
			has = true;
			i = j + 1;
		} else if (c === "\\") {
			const n = text[i + 1];
			if (n !== "(" && n !== ")") return null;
			tok += n;
			has = true;
			i += 2;
		} else if (UNQUOTED.test(c)) {
			tok += c;
			has = true;
			i++;
		} else {
			return null;
		}
	}
	if (has) out.push(tok);
	return out;
}

const NUM = /^-?\d+(?:\.\d+)?$/;
const GEOMETRY = /^(?=.*\d)[0-9x+.%^-]{1,32}$/;
const NAME = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const COLOR =
	/^(?:#[0-9A-Fa-f]{3,4}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8}|[A-Za-z]{1,30}[0-9]{0,3}|(?:s?rgba?|hsla?|hsba?|gray|graya|cmyka?)\([0-9., ]{1,60}\))$/;
/** A font NAME as type.xml or fontconfig knows it: never a path. */
const FONT = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
/** One shape primitive with numeric `x,y` points: no `image`, `text`, `url(`, quotes or `@`. */
const DRAW =
	/^(?:point|line|rectangle|roundrectangle|arc|ellipse|circle|polyline|polygon|bezier)(?: +-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?){1,32}$/;
const LIST = /^[0-9., -]{1,64}$/;
/** Text drawn on the image: no `%` (property escapes), no `@` (refused for the line), no control. */
const TEXT = /^[^%]{0,2000}$/;

type Check = (v: string) => boolean;
const re =
	(r: RegExp): Check =>
	(v) =>
		r.test(v);
const num = re(NUM);
const geom = re(GEOMETRY);
const name = re(NAME);
const color = (v: string) => COLOR.test(v) || v === "none";
const text = re(TEXT);

/** Each allowed option and the validators of the arguments it takes. Exact spelling, sign included. */
const OPTIONS: Readonly<Record<string, readonly Check[]>> = {
	"-size": [geom],
	"+size": [],
	"-fill": [color],
	"-stroke": [color],
	"-strokewidth": [num],
	"-background": [color],
	"-bordercolor": [color],
	"-undercolor": [color],
	"-border": [geom],
	"-font": [re(FONT)],
	"-family": [re(FONT)],
	"-weight": [(v) => NAME.test(v) || NUM.test(v)],
	"-style": [name],
	"-pointsize": [num],
	"-density": [geom],
	"-kerning": [num],
	"-interword-spacing": [num],
	"-interline-spacing": [num],
	"-lineheight": [num],
	"-gravity": [name],
	"-geometry": [geom],
	"-page": [geom],
	"-repage": [geom],
	"+repage": [],
	"-compose": [name],
	"-composite": [],
	"-flatten": [],
	"-append": [],
	"+append": [],
	"-blur": [geom],
	"-gaussian-blur": [geom],
	"-sharpen": [geom],
	"-shadow": [geom],
	"-vignette": [geom],
	"-channel": [name],
	"+channel": [],
	"-evaluate": [name, num],
	"-draw": [re(DRAW)],
	"-annotate": [geom, text],
	"-resize": [geom],
	"-extent": [geom],
	"-crop": [geom],
	"-splice": [geom],
	"-rotate": [num],
	"-modulate": [re(LIST)],
	"-alpha": [name],
	"-colorspace": [name],
	"-virtual-pixel": [name],
	"-layers": [name],
	"-quality": [num],
	"-depth": [num],
	"-swap": [re(LIST)],
	"+swap": [],
	"-clone": [re(LIST)],
	"+clone": [],
	"-flip": [],
	"-flop": [],
	"-negate": [],
	"-trim": [],
	"-strip": [],
	"-antialias": [],
	"+antialias": [],
	"-quiet": [],
	"-write": [],
	"+write": [],
};

/** Options whose argument is a file the command writes: checked as an output, not by OPTIONS. */
const WRITE_OPTIONS = new Set(["-write", "+write"]);

/** Built-in image generators: they read nothing from disk or the network. */
const GENERATORS: Readonly<Record<string, Check>> = {
	xc: (v) => v === "" || color(v),
	canvas: (v) => v === "" || color(v),
	gradient: gradientValue,
	"radial-gradient": gradientValue,
	pattern: re(/^[A-Za-z0-9]{1,32}$/),
	plasma: (v) => v === "" || v === "fractal" || gradientValue(v),
	label: text,
	caption: text,
};

/** `""`, one color, or two colors joined by `-` (each color may itself hold no `-`). */
function gradientValue(v: string): boolean {
	if (v === "" || color(v)) return true;
	const parts = v.split("-");
	return parts.length === 2 && parts.every(color);
}

/** Image files this lane lets a render write. */
const OUTPUT_EXT = /\.(?:png|jpe?g|webp|gif)$/i;

/**
 * Characters an output path may hold. No glob character (`*` `?` `[` `]` `{` `}`) and no `~`:
 * the shell leaves a quoted glob alone, but ImageMagick's own ExpandFilenames expands it, and
 * `convert ... '*.png'` turns every match but the last into an input (a workspace file read) and
 * writes the last, through a symlink if it is one (#4180 review). The first character is not
 * `-` or `+`, so the output can never be read as an option.
 */
const OUTPUT_CHARS = /^[A-Za-z0-9_./ ,=][A-Za-z0-9_./ ,+=-]*$/;

/** ImageMagick configuration file names; some builds read them from the current directory. */
const CONFIG_NAMES = [
	"policy.xml",
	"delegates.xml",
	"type.xml",
	"type-ghostscript.xml",
	"type-dejavu.xml",
	"type-windows.xml",
	"type-urw-base35.xml",
	"type-apple.xml",
	"colors.xml",
	"coder.xml",
	"configure.xml",
	"log.xml",
	"magic.xml",
	"mime.xml",
	"locale.xml",
	"english.xml",
	"thresholds.xml",
	"quantization-table.xml",
];

/** Environment that points ImageMagick or fontconfig at configuration it would not otherwise read. */
const CONFIG_ENV = /^(?:MAGICK_|FONTCONFIG_)/;

/** True when every existing ancestor of `abs` strictly below `root` is a real directory. */
function noSymlinkBelow(abs: string, root: string): boolean {
	for (let cur = path.dirname(abs); cur !== root && inside(cur, root); cur = path.dirname(cur)) {
		if (lstatOrNull(cur)?.isSymbolicLink()) return false;
	}
	return true;
}

/**
 * True when `raw` is an output this lane lets the render write; see the module header. Containment
 * is checked against `root` (the working directory); the dot and protected-path rules against
 * `project`, so `cd sub && magick ... P` and `magick ... sub/P` get the same answer.
 */
function outputOk(raw: string | undefined, root: string, project: string): boolean {
	if (!raw || raw.includes(":") || raw.includes("%")) return false;
	if (!OUTPUT_CHARS.test(raw) || !OUTPUT_EXT.test(raw)) return false;
	// Containment through the shared resolver: it follows every existing symlink on the way.
	if (!checkPath(raw, root).allowed) return false;
	const abs = path.resolve(root, raw);
	const rel = path.relative(project, abs);
	if (rel.split("/").some((s) => s.startsWith(".") && s !== ".tmp" && s !== "..")) return false;
	if (!noSymlinkBelow(abs, root)) return false;
	const st = lstatOrNull(abs);
	// lstat: a symlink, even a dangling one, is not a file.
	if (st && (!st.isFile() || st.nlink !== 1)) return false;
	if (protectedName(path.basename(abs), true)) return false;
	if (protectedRel(rel)) return false;
	return true;
}

/**
 * True when `dir` is absolute and resolves outside every root, a dangling link followed to where it
 * points (pathOutsideWorkspace's resolver, given `dir` as a one-entry list).
 */
function outsideRoots(dir: string, roots: string[]): boolean {
	return roots.every((r) => pathOutsideWorkspace(r, dir));
}

export function magickRenderInProject(
	command: string,
	cwd: string | undefined,
	env: Record<string, string | undefined> = process.env,
	/** The project root when `cwd` is a folder a `cd <folder> &&` chose inside it (#3199, #4169). */
	project?: string,
): MagickRender {
	try {
		if (process.platform === "win32") return NO;
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!/^[\x20-\x7e]+$/.test(text)) return NO;
		if (/[@$`]/.test(text)) return NO;
		const words = strictWords(text);
		if (!words || words.length < 2) return NO;
		if (words[0] !== "magick" && words[0] !== "convert") return NO;

		const root = resolveSafe(cwd, cwd);
		const roots = project === undefined ? [root] : [root, resolveSafe(project, project)];
		if (roots.some((r) => !inside(root, r))) return NO;

		const outputs: (string | undefined)[] = [words[words.length - 1]];
		const args = words.slice(1, -1);
		for (let i = 0; i < args.length; i++) {
			const w = args[i];
			if (w === "(" || w === ")") continue;
			if ((w.startsWith("-") || w.startsWith("+")) && w.length > 1) {
				const checks = OPTIONS[w];
				if (!checks) return NO;
				if (WRITE_OPTIONS.has(w)) {
					outputs.push(args[++i]);
					continue;
				}
				for (const check of checks) {
					const v = args[++i];
					if (v === undefined || !check(v)) return NO;
				}
				// ImageMagick loads `-font NAME` as a file when NAME exists relative to the
				// current directory (annotate.c: IsPathAccessible before the type lookup), so a
				// font name that is also a workspace entry is a file read (#4180 review).
				if (w === "-font" && lstatOrNull(path.join(root, args[i]))) return NO;
				continue;
			}
			// An image the command reads: a built-in generator, never a file.
			const colon = w.indexOf(":");
			if (colon <= 0) return NO;
			const gen = GENERATORS[w.slice(0, colon)];
			if (!gen || !gen(w.slice(colon + 1))) return NO;
		}
		const top = roots[roots.length - 1];
		for (const o of outputs) if (!outputOk(o, root, top)) return NO;

		// The magick that runs, and the configuration it reads, are not the workspace's.
		const pathEnv = env.PATH ?? process.env.PATH ?? "";
		if (roots.some((r) => !pathOutsideWorkspace(r, pathEnv))) return NO;
		if (Object.keys(env).some((k) => CONFIG_ENV.test(k) && env[k] !== undefined)) return NO;
		const {
			HOME: home,
			XDG_CONFIG_HOME: xdg,
			XDG_DATA_HOME: xdgData,
			XDG_CACHE_HOME: xdgCache,
		} = env;
		const userConfig = [
			...(home
				? [
						path.join(home, ".config", "ImageMagick"),
						path.join(home, ".magick"),
						// fontconfig: per-user configuration and font folders (FreeType parses them).
						path.join(home, ".config", "fontconfig"),
						path.join(home, ".fonts.conf"),
						path.join(home, ".fonts"),
						path.join(home, ".local", "share", "fonts"),
					]
				: []),
			...(xdg ? [path.join(xdg, "ImageMagick"), path.join(xdg, "fontconfig")] : []),
			...(xdgData ? [path.join(xdgData, "fonts")] : []),
			// Cautious, not proven: fontconfig keeps its cache folder here.
			...(xdgCache ? [path.join(xdgCache, "fontconfig")] : []),
		];
		if (userConfig.some((d) => !outsideRoots(d, roots))) return NO;
		for (const r of roots)
			for (const n of CONFIG_NAMES) if (lstatOrNull(path.join(r, n))) return NO;

		return {
			ok: true,
			reason: `${words[0]} render from built-in generators to an image inside the workspace`,
		};
	} catch {
		return NO;
	}
}
