/**
 * @8gent/eyes — chunk-and-merge for long videos (VIDEO-INGESTION spec §8).
 *
 * Marlin caps at 240 frames / ~2 minutes per window. Videos longer than that
 * must be chunked or they silently truncate.
 *
 * DESIGN DECISION (spec §8 vs §5.5 ambiguity):
 *   Spec §5.5 gives the sidecar an `extract` convenience method that can do
 *   chunk-and-merge internally; spec §8 says "Chunking lives in the tool, not
 *   the sidecar's caption method". These conflict. This implementation
 *   follows §8: the tool plans windows and calls `caption` once per window,
 *   then merges in TypeScript. Rationale:
 *     - `caption` stays a pure single-window primitive (spec §5.2 wording).
 *     - Chunk-and-merge becomes unit-testable without a live sidecar.
 *     - The tool can emit per-window progress (spec §8 final paragraph).
 *   The sidecar's `extract` method is left unused by this tool; the audio
 *   side still goes through one `transcribe` call.
 *
 * This module is pure: it plans windows and merges `caption` results. It
 * never touches a process. That is what makes the >2min path testable.
 */

import type { VideoEvent } from "../types.js";

/** Marlin window ceiling in seconds (240 frames at 2 fps). */
export const MAX_CHUNK_SEC = 120;
/** Marlin needs at least 4 sampled frames; at 2 fps that is 2 seconds. */
const MIN_WINDOW_SEC = 2;
/** Seam-dedup tolerance: how close to a boundary an event must sit. */
const SEAM_EPSILON_SEC = 0.5;
/** Token Jaccard similarity above which two seam events are "the same". */
const SEAM_JACCARD_THRESHOLD = 0.8;

/** One planned caption window. */
export interface ChunkWindow {
	index: number;
	startSec: number;
	endSec: number;
}

/** The raw result of one `caption` call, before rebasing. */
export interface CaptionResult {
	scene: string;
	events: VideoEvent[]; // window-relative times
	frameCount?: number;
	truncated?: boolean;
}

/**
 * Plan caption windows for a video of `durationSec` (spec §8 step 1).
 *
 * Splits into windows of at most `maxChunkSec`. The final window may be
 * short; if it would fall under the 4-frame minimum it is merged into the
 * previous window rather than emitted as an un-captionable sliver.
 */
export function planChunks(durationSec: number, maxChunkSec = MAX_CHUNK_SEC): ChunkWindow[] {
	if (durationSec <= 0) return [];
	if (durationSec <= maxChunkSec) {
		return [{ index: 0, startSec: 0, endSec: durationSec }];
	}
	const windows: ChunkWindow[] = [];
	let start = 0;
	let index = 0;
	while (start < durationSec) {
		const end = Math.min(start + maxChunkSec, durationSec);
		windows.push({ index, startSec: start, endSec: end });
		start = end;
		index++;
	}
	// Merge a too-short tail window into its predecessor.
	if (windows.length >= 2) {
		const last = windows[windows.length - 1];
		if (last.endSec - last.startSec < MIN_WINDOW_SEC) {
			const prev = windows[windows.length - 2];
			prev.endSec = last.endSec;
			windows.pop();
		}
	}
	return windows;
}

/**
 * Rebase a window's events onto the absolute media timeline (spec §8 step 3)
 * and clamp any timestamp that runs past the clip duration (spec §13:
 * "Marlin timestamp beyond duration → clamp event end to durationSec").
 */
export function rebaseEvents(
	events: VideoEvent[],
	windowStartSec: number,
	durationSec: number,
): VideoEvent[] {
	return events.map((e) => {
		const start = Math.min(windowStartSec + e.start, durationSec);
		const end = Math.min(windowStartSec + e.end, durationSec);
		return { start, end: Math.max(start, end), description: e.description };
	});
}

/** Lower-cased, de-punctuated token set of a description. */
function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.split(/\s+/)
			.filter((t) => t.length > 0),
	);
}

/** Token Jaccard similarity of two descriptions, in [0, 1]. */
export function jaccard(a: string, b: string): number {
	const sa = tokenize(a);
	const sb = tokenize(b);
	if (sa.size === 0 && sb.size === 0) return 1;
	let inter = 0;
	for (const t of sa) if (sb.has(t)) inter++;
	const union = sa.size + sb.size - inter;
	return union === 0 ? 0 : inter / union;
}

/**
 * Merge already-rebased events from multiple windows into one sorted list,
 * deduplicating the seam (spec §8 step 4): an event ending within ε of a
 * window boundary and an event in the next window starting within ε with a
 * near-identical description (token Jaccard > 0.8) collapse into one event
 * spanning both.
 *
 * `boundaries` are the absolute media times where one window ends and the
 * next begins.
 */
export function mergeEvents(rebasedPerWindow: VideoEvent[][], boundaries: number[]): VideoEvent[] {
	// Flatten with a window tag so we can tell which events straddle a seam.
	const tagged: { ev: VideoEvent; win: number }[] = [];
	rebasedPerWindow.forEach((evs, win) => {
		for (const ev of evs) tagged.push({ ev, win });
	});
	tagged.sort((a, b) => a.ev.start - b.ev.start || a.ev.end - b.ev.end);

	const boundarySet = boundaries;
	const nearBoundary = (t: number): boolean =>
		boundarySet.some((b) => Math.abs(t - b) <= SEAM_EPSILON_SEC);

	const merged: { ev: VideoEvent; win: number }[] = [];
	for (const cur of tagged) {
		const prev = merged[merged.length - 1];
		if (
			prev &&
			cur.win === prev.win + 1 &&
			nearBoundary(prev.ev.end) &&
			nearBoundary(cur.ev.start) &&
			jaccard(prev.ev.description, cur.ev.description) > SEAM_JACCARD_THRESHOLD
		) {
			// Collapse: extend the previous event across the seam.
			prev.ev = {
				start: prev.ev.start,
				end: Math.max(prev.ev.end, cur.ev.end),
				description: prev.ev.description,
			};
			prev.win = cur.win; // allow a further seam merge into the next window
			continue;
		}
		merged.push({ ev: { ...cur.ev }, win: cur.win });
	}
	return merged.map((m) => m.ev).sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Merge per-window scene paragraphs (spec §8 step 5). The stage-2 LLM
 * summarization is the responsibility of `video-extractor.ts` (#2633); when
 * it is unavailable the concatenation is kept verbatim, which is exactly
 * what this function returns. The tool ships the concatenation; #2633 may
 * later replace it with a summarized paragraph.
 */
export function mergeScenes(scenes: string[]): string {
	return scenes
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.join(" ");
}
