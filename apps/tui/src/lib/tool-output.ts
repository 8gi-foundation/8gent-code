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

/** Rows a collapsed failure may take, wrapped lines counted. */
export const COLLAPSED_ROWS = 18;

/** Rows one output line may take before it is cut. */
export const LINE_ROWS = 3;

/**
 * One line as at most three rows. A line is cut only after the last row, so
 * the cause at the end of "Expected ... Received ..." survives a 40 column
 * screen. A break falls at a space or after - / : , when one sits in the back
 * half of the row. Later rows are indented two cells, or carry the diff
 * marker (+ or -) so a wrapped change still reads as one.
 */
export function wrapLine(s: string, room: number): string[] {
	if (s.length <= room) return [s];
	const marker = /^[+-](?![+-]{2})/.test(s) && room > 8 ? `${s[0]} ` : "  ";
	const rows: string[] = [];
	let rest = s;
	let width = room;
	while (rows.length < LINE_ROWS) {
		const last = rows.length === LINE_ROWS - 1;
		if (rest.length <= width) {
			rows.push(rest);
			break;
		}
		if (last) {
			rows.push(`${rest.slice(0, Math.max(0, width - 1))}…`);
			break;
		}
		let cut = width;
		for (let i = width; i > Math.floor(width / 2); i--) {
			if (rest[i] === " " || "/-:,".includes(rest[i - 1] ?? "")) {
				cut = i;
				break;
			}
		}
		rows.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
		width = Math.max(1, room - marker.length);
	}
	return rows.map((r, i) => (i === 0 ? r : marker + r));
}

/** Room a line has beside the row's two-cell gutter and indent. */
export const GUTTER = 4;

export function viewOutput(
	body: string[],
	opts: { status: TrailStatus; expanded: boolean; width: number; seq: number },
): OutputView {
	const room = Math.max(1, opts.width - GUTTER);
	const narrow = opts.width < 60;
	const fit = (ls: string[]) => ls.flatMap((l) => wrapLine(l, room));
	if (body.length === 0) return { lines: [], hint: null };
	if (!opts.expanded) {
		if (opts.status === "ok") return { lines: [], hint: null };
		if (body.length <= COLLAPSED_LINES) return { lines: fit(body), hint: null };
		let tail = body.slice(-COLLAPSED_LINES);
		// Wrapped rows count: drop the oldest lines until the tail fits its rows.
		while (tail.length > 1 && fit(tail).length > COLLAPSED_ROWS) tail = tail.slice(1);
		const hidden = body.length - tail.length;
		const hint = narrow
			? `${hidden} more  /out ${opts.seq}`
			: `${hidden} more lines (^O or tap, /out ${opts.seq})`;
		return { lines: fit(tail), hint: clip(hint, room) };
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
