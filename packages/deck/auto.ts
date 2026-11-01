/**
 * 8gent Code - the deck video default.
 *
 * Every time the agent writes a Marp deck (a `.md` file whose front matter
 * says `marp: true`), a narrated MP4 is rendered beside it. This is not a
 * model decision: the write tools call this after every successful write.
 * A render failure never fails the write; it becomes one line in the result.
 *
 * Opt out with EIGHT_DECK_VIDEO=0.
 */

import { extname, relative, sep } from "node:path";
import { isMarpDeck } from "./parse";
import { type DeckRenderResult, renderDeckVideo } from "./render";

export function deckVideoEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const v = env.EIGHT_DECK_VIDEO?.trim().toLowerCase();
	return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** True when a just-written file should get a deck video. */
export function shouldRenderDeckVideo(
	filePath: string,
	content: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!deckVideoEnabled(env)) return false;
	const ext = extname(filePath).toLowerCase();
	if (ext !== ".md" && ext !== ".markdown") return false;
	return isMarpDeck(content);
}

export function formatDeckVideoLine(result: DeckRenderResult, baseDir?: string): string {
	const shown = baseDir
		? (relative(baseDir, result.output) || result.output).split(sep).join("/")
		: result.output;
	return `rendered ${shown}: ${result.slides} slides, ${result.seconds}s, voice ${result.voice}`;
}

/**
 * Render the deck video when `filePath` is a Marp deck. Returns the line to
 * append to the tool result ("" when the file is not a deck or opted out).
 * Never throws.
 */
export async function deckVideoAfterWrite(
	filePath: string,
	content: string,
	baseDir?: string,
	render: typeof renderDeckVideo = renderDeckVideo,
): Promise<string> {
	try {
		if (!shouldRenderDeckVideo(filePath, content)) return "";
		const result = await render(filePath);
		return formatDeckVideoLine(result, baseDir);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return `deck video not rendered: ${reason}`;
	}
}
