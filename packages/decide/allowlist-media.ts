/**
 * Media tools in the rules-first allowlist: `ffprobe` (read a file's facts) and
 * `magick` (draw an image from a generator such as xc: into a new image file).
 *
 * Why: in the media-brief-video pilot the Selene judge answered "escalate" to
 * plain slide-drawing `magick -annotate` calls and to `ffprobe` on the film.
 * With no person to ask, escalate is a refusal, so the run could not make or
 * check its video. Neither tool needs a model when its arguments are this narrow.
 *
 * Both answer only null (ok) or a reason. decideRules, the prompt-control check
 * and the secret-name check run before, in allowlist.ts, so this can only remove
 * a model call. Pure, never throws. Prompt text only: nothing is executed.
 *
 * ffprobe: only the read/print options below; every path is relative and inside
 * the working directory; no URL, no `scheme:` input (concat:, file:, pipe:), no
 * `@file`; no -f (lavfi), no -i of a device.
 * magick: only the drawing options below; the last argument is a new image file
 * (a raster extension, relative, inside the working directory) so it can never
 * overwrite source code; no -write, -script, -profile, -define, no svg, mvg or
 * msl input, no `scheme:` other than the pure generators, no `@file`.
 */

const REL_PATH_BAD = /^[/~]|(^|\/)\.\.(\/|$)|[*?[\]{}$]/;
const OPTION = /^[-+][a-zA-Z]/;
const RASTER = /\.(png|jpe?g|gif|webp|bmp|tiff?|ppm|pgm|pbm)$/i;
const FONT_FILE = /\.(ttf|otf|ttc)$/i;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9_]*:/;

const FFPROBE_OPTS = new Set([
	"v", "loglevel", "hide_banner", "show_format", "show_streams", "show_entries", "of", "print_format", "select_streams",
	"i", "count_frames", "count_packets", "sexagesimal", "pretty", "show_chapters", "show_programs", "show_packets",
	"show_frames", "show_error", "unit", "prefix", "byte_binary_prefix", "bitexact", "analyzeduration", "probesize",
]);

const MAGICK_OPTS = new Set([
	"size", "background", "fill", "stroke", "strokewidth", "font", "pointsize", "gravity", "annotate", "draw", "geometry",
	"resize", "scale", "crop", "extent", "trim", "border", "bordercolor", "colorspace", "depth", "quality", "flatten",
	"append", "rotate", "flip", "flop", "blur", "sharpen", "gaussian-blur", "composite", "compose", "alpha", "antialias",
	"kerning", "interline-spacing", "interword-spacing", "undercolor", "density", "thumbnail", "strip", "repage",
	"shadow", "vignette", "unsharp", "negate", "normalize", "modulate", "level", "brightness-contrast", "gamma",
	"sepia-tone", "monochrome", "auto-orient", "shave", "splice", "roll", "fuzz", "transparent", "opaque", "delay",
	"loop", "coalesce", "layers", "colors", "dither", "type", "units", "page", "text-encoding", "family", "style",
	"weight", "stretch", "tile", "virtual-pixel", "filter", "sampling-factor", "interlace", "orient", "label", "caption",
]);
/** Pure generators: no file or network is read. */
const GENERATORS = new Set(["xc", "canvas", "caption", "label", "gradient", "radial-gradient", "plasma", "null", "pattern"]);

function relPath(p: string): boolean {
	return !REL_PATH_BAD.test(p);
}

export function ffprobeOk(args: string[]): string | null {
	if (args.length === 0) return "ffprobe with no input";
	let sawInput = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const isValue = i > 0 && OPTION.test(args[i - 1]) && args[i - 1] !== "-i";
		if (isValue && !OPTION.test(a) && /[=:]/.test(a)) {
			// An option's value with = or : (-select_streams v:0, -of csv=p=0) is a selector, never an input file.
			if (a.startsWith("@") || a.includes("://")) return `ffprobe reads ${a}`;
			continue;
		}
		if (OPTION.test(a)) {
			const name = a.slice(1);
			if (!FFPROBE_OPTS.has(name)) return `ffprobe option ${a} is not on the read list`;
			if (name === "i") {
				const v = args[++i];
				if (v === undefined || !relPath(v) || SCHEME.test(v)) return "ffprobe -i outside the working directory";
				sawInput = true;
			}
			continue;
		}
		if (a.startsWith("@") || a.includes("://")) return `ffprobe reads ${a}`;
		// A value of the options above (-of default=nw=1:nk=1, -show_entries stream=x:format=y) has "=" before any ":".
		if (SCHEME.test(a)) return `ffprobe input with a ${a.split(":")[0]}: scheme`;
		if (a.includes("/") || /\.[a-z0-9]{2,4}$/i.test(a)) {
			if (!relPath(a)) return `ffprobe reads ${a}, outside the working directory`;
			sawInput = true;
		}
	}
	return sawInput ? null : "ffprobe names no input file";
}

export function magickOk(args: string[]): string | null {
	if (args.length < 2) return "magick with no output file";
	if (!OPTION.test(args[0]) && !SCHEME.test(args[0]) && !RASTER.test(args[0])) return `magick ${args[0]} is not a plain drawing call`;
	const out = args[args.length - 1];
	if (OPTION.test(out) || !RASTER.test(out) || SCHEME.test(out) || !relPath(out)) return `magick output ${out} is not a new image file in the working directory`;
	for (let i = 0; i < args.length - 1; i++) {
		const a = args[i];
		if (OPTION.test(a)) {
			if (!MAGICK_OPTS.has(a.slice(1))) return `magick option ${a} is not on the drawing list`;
			continue;
		}
		if (a.startsWith("@") || a.includes(":@") || a.includes("://")) return `magick reads ${a}`;
		if (SCHEME.test(a) && !GENERATORS.has(a.slice(0, a.indexOf(":")).toLowerCase())) return `magick ${a.split(":")[0]}: is not a pure generator`;
		if (/\.(svg|mvg|msl)$/i.test(a)) return `magick reads ${a}`;
		if (RASTER.test(a) || FONT_FILE.test(a)) {
			if (!relPath(a)) return `magick reads ${a}, outside the working directory`;
		}
	}
	return null;
}
