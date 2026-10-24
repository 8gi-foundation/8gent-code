/**
 * Tool output under its trail row (#4954): the pure half.
 *
 * The agent keeps each call's full output (capped, packages/eight/tool-output.ts); this turns it
 * into the lines a row shows. A failure shows its tail by default, because the cause is at the
 * end (stdout then stderr), so "exit 1" never stands alone. A success shows nothing until the
 * person opens it (Ctrl+O, a tap on the row, or /out). Opened, it shows the first 40 lines and
 * the last 10, or all of it when that is 50 lines or fewer. Every line is cut to the column.
 */

import type { TrailStatus } from "./tool-trail.js";

export const COLLAPSED_LINES = 10;
export const EXPANDED_HEAD = 40;
export const EXPANDED_TAIL = 10;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** The lines of a result: header and escapes gone, trailing blanks dropped. */
export function outputBody(output: string, status: TrailStatus): string[] {
	let text = output.replace(ANSI, "").replace(/\t/g, "  ").replace(CONTROL, "");
	if (status !== "ok") text = text.replace(/^\s*Exit code (?:-?\d+|null):[ \t]*\r?\n?/, "");
	const lines = text.split(/\r\n|\r|\n/);
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	return lines;
}

export interface OutputView {
	lines: string[];
	hint: string | null;
}

function clip(s: string, width: number): string {
	return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
}

/** Room a line has beside the row's two-cell gutter and indent. */
export const GUTTER = 4;

export function viewOutput(
	body: string[],
	opts: { status: TrailStatus; expanded: boolean; width: number; seq: number },
): OutputView {
	const room = Math.max(1, opts.width - GUTTER);
	const narrow = opts.width < 60;
	const fit = (ls: string[]) => ls.map((l) => clip(l, room));
	if (body.length === 0) return { lines: [], hint: null };
	if (!opts.expanded) {
		if (opts.status === "ok") return { lines: [], hint: null };
		if (body.length <= COLLAPSED_LINES) return { lines: fit(body), hint: null };
		const hidden = body.length - COLLAPSED_LINES;
		const hint = narrow
			? `${hidden} more  /out ${opts.seq}`
			: `${hidden} more lines (^O or tap, /out ${opts.seq})`;
		return { lines: fit(body.slice(-COLLAPSED_LINES)), hint: clip(hint, room) };
	}
	const close = narrow ? "tap to close" : "^O or tap to collapse";
	if (body.length <= EXPANDED_HEAD + EXPANDED_TAIL) return { lines: fit(body), hint: close };
	const hidden = body.length - EXPANDED_HEAD - EXPANDED_TAIL;
	return {
		lines: fit([
			...body.slice(0, EXPANDED_HEAD),
			`... ${hidden} lines not shown ...`,
			...body.slice(-EXPANDED_TAIL),
		]),
		hint: close,
	};
}
