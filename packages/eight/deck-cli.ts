/**
 * `8gent deck render <spec.json> [out.mp4]`: the shell door to render_video_deck.
 *
 * Pilot media-brief-video (12 Oct 2026, qwen3.8 27B): the model never called
 * the render_video_deck tool. It did what the brief literally said and what
 * frontier models default to anyway: it composed the video by hand with magick,
 * espeak-ng and nine ffmpeg calls in run_command. The deterministic renderer has
 * to be reachable from the shell, in one line, or bash wins.
 *
 * This is the SAME code as the tool, not a copy: the spec and output paths go
 * through the tool's own confinement (confineRead / resolveDeckOut in tools.ts)
 * and the render is renderVideoDeck (packages/tools/video-deck.ts), so every
 * guard holds here too: paths inside the current directory only, no symlinks,
 * the slide / seconds / image caps, ffmpeg resolved from an absolute PATH entry
 * outside the workspace, and a fixed ffmpeg argv that allows only the file
 * protocol. The command never starts a model loop and never touches the network.
 *
 * Prints the tool's result JSON ({ path, durationSec, durationLabel, starts, chapters, chaptersPath, slides, ... })
 * on success, and writes chapters.txt ('m:ss Title' per slide) next to the mp4.
 * Exit codes: 0 rendered, 1 refused or failed, 2 usage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { RenderDeckOptions, RenderDeckResult } from "../tools/video-deck";

/** A deck spec is a few KB of JSON; anything larger is not a deck spec. */
export const MAX_SPEC_BYTES = 1024 * 1024;

export const DECK_USAGE =
	"Usage: 8gent deck render <spec.json> [out.mp4]\n" +
	"  Renders a JSON deck spec into an mp4 with the same code as the render_video_deck tool.\n" +
	'  spec: { "title"?, "size"?: "1280x720"|"1920x1080", "voice"?, "slides": [ { "kicker"?, "title"?, "text"?,\n' +
	'          "bullets"?: [..], "image"?: "png/jpg inside this directory", "seconds"?: 1-60, "narration"?, "voice"? } ] }\n' +
	"  Both paths must be inside the current directory. out defaults to deck.mp4.\n" +
	"  Also writes chapters.txt ('m:ss Title' per slide) beside the mp4; the name is fixed, so it overwrites.";

export interface DeckCliDeps {
	/** The working directory every path is confined to (default process.cwd()). */
	cwd?: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
	/** Test seam only; the CLI always renders with renderVideoDeck. */
	render?: (opts: RenderDeckOptions) => Promise<RenderDeckResult>;
}

/** `8gent deck <sub> ...`. Returns the exit code; prints through deps. */
export async function runDeckCommand(args: string[], deps: DeckCliDeps = {}): Promise<number> {
	const log = deps.log ?? ((line: string) => console.log(line));
	const error = deps.error ?? ((line: string) => console.error(line));
	const [sub, specArg, outArg, ...extra] = args;
	if (sub !== "render" || !specArg || extra.length > 0 || args.some((a) => a.startsWith("-"))) {
		log(DECK_USAGE);
		return 2;
	}
	const cwd = deps.cwd ?? process.cwd();
	try {
		// The tool's own path confinement: lexical, then the real location after links.
		const { confineRead, resolveDeckOut, resolveDeckChapters } = await import("./tools");
		const specPath = confineRead(specArg, cwd);
		if (!/\.json$/i.test(specPath)) throw new Error(`spec must be a .json file ("${specArg}")`);
		const st = fs.statSync(specPath);
		if (!st.isFile()) throw new Error(`spec is not a file ("${specArg}")`);
		if (st.size > MAX_SPEC_BYTES)
			throw new Error(`spec is ${st.size} bytes; the limit is ${MAX_SPEC_BYTES}`);
		let spec: unknown;
		try {
			spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
		} catch (e) {
			throw new Error(`spec is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
		}
		const out = resolveDeckOut(outArg, cwd);
		resolveDeckChapters(out, cwd);
		const render = deps.render ?? (await import("../tools/video-deck")).renderVideoDeck;
		const result = await render({ spec, out, cwd });
		log(JSON.stringify({ ...result, path: path.relative(cwd, result.path) || result.path }));
		return 0;
	} catch (err) {
		error(`8gent deck render failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
