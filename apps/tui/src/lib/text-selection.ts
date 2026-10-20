/**
 * Drag-to-select for the HUD (#4602): the model behind it, free of Ink and
 * stdin so it is tested with plain numbers.
 *
 * A press off every click target starts a selection. Under CLICK_SLOP cells
 * of movement it is a click and copies nothing; further than that it is a
 * drag and the release copies the covered text. A second press on the same
 * spot inside MULTI_CLICK_MS selects the word, a third the line. The text is
 * read from the screen rows Ink last drew (ANSI already stripped), so what is
 * copied is what the person saw. The selection is positional: it covers the
 * cells that were dragged, not a message, and lives until Escape or the next
 * press.
 */

import { cellWidth } from "./header-layout.js";

export interface SelRange {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Movement under this many cells (either axis) between press and release is a click. */
export const CLICK_SLOP = 2;
/** Presses closer together than this, on the same spot, count as a double or triple click. */
export const MULTI_CLICK_MS = 400;

/** The characters of `line` that sit in cells [from, to): a wide character takes two. */
export function sliceCells(line: string, from: number, to: number): string {
	let col = 0;
	let out = "";
	for (const ch of line) {
		const w = cellWidth(ch);
		if (col + w > from && col < to) out += ch;
		col += w;
		if (col >= to) break;
	}
	return out;
}

/** Width of `line` in cells. */
export function lineWidth(line: string): number {
	let w = 0;
	for (const ch of line) w += cellWidth(ch);
	return w;
}

/** The two ends of a range in reading order. */
export function ordered(sel: SelRange): [{ x: number; y: number }, { x: number; y: number }] {
	const fwd = sel.y0 < sel.y1 || (sel.y0 === sel.y1 && sel.x0 <= sel.x1);
	return fwd
		? [
				{ x: sel.x0, y: sel.y0 },
				{ x: sel.x1, y: sel.y1 },
			]
		: [
				{ x: sel.x1, y: sel.y1 },
				{ x: sel.x0, y: sel.y0 },
			];
}

/** The text a range covers, row by row, trailing spaces trimmed. */
export function extractText(screen: string, sel: SelRange): string {
	const lines = screen.split("\n");
	const [a, b] = ordered(sel);
	const out: string[] = [];
	for (let y = a.y; y <= b.y; y++) {
		const from = y === a.y ? a.x : 0;
		const to = y === b.y ? b.x + 1 : Number.POSITIVE_INFINITY;
		out.push(sliceCells(lines[y] ?? "", from, to).trimEnd());
	}
	return out.join("\n");
}

const WORD_CHAR = /[\p{L}\p{N}_\-/~.@]/u;

/** The word under cell `col` as [from, to) cells, or null on a space. Trailing dots stay out. */
export function wordAt(line: string, col: number): { from: number; to: number } | null {
	const cells: Array<{ ch: string; from: number; to: number }> = [];
	let c = 0;
	for (const ch of line) {
		const w = cellWidth(ch);
		cells.push({ ch, from: c, to: c + w });
		c += w;
	}
	let i = cells.findIndex((k) => col >= k.from && col < k.to);
	if (i < 0 || !WORD_CHAR.test(cells[i].ch)) return null;
	let lo = i;
	let hi = i;
	while (lo > 0 && WORD_CHAR.test(cells[lo - 1].ch)) lo--;
	while (hi + 1 < cells.length && WORD_CHAR.test(cells[hi + 1].ch)) hi++;
	while (hi > lo && cells[hi].ch === ".") hi--;
	i = hi;
	return { from: cells[lo].from, to: cells[i].to };
}

export type ReleaseResult =
	| { kind: "copy"; text: string }
	| { kind: "click" }
	| { kind: "none" };

export class TextSelection {
	private anchor = { x: 0, y: 0 };
	private down = false;
	private moved = false;
	private mode: "char" | "word" | "line" = "char";
	private clicks = 0;
	private lastPress: { x: number; y: number; at: number } | null = null;
	private current: SelRange | null = null;

	constructor(
		private read: () => string,
		private now: () => number = Date.now,
	) {}

	/** Swap where the screen text comes from. */
	setReader(read: () => string): void {
		this.read = read;
	}

	/** The cells to draw inverted, or null. */
	get range(): SelRange | null {
		return this.current;
	}

	get dragging(): boolean {
		return this.down;
	}

	press(x: number, y: number): void {
		const t = this.now();
		const lp = this.lastPress;
		const near = lp && Math.max(Math.abs(lp.x - x), Math.abs(lp.y - y)) < CLICK_SLOP;
		this.clicks = lp && near && t - lp.at <= MULTI_CLICK_MS ? (this.clicks % 3) + 1 : 1;
		this.lastPress = { x, y, at: t };
		this.anchor = { x, y };
		this.down = true;
		this.moved = false;
		this.current = null;
		this.mode = this.clicks === 2 ? "word" : this.clicks === 3 ? "line" : "char";
		if (this.mode === "char") return;
		const line = this.read().split("\n")[y] ?? "";
		if (this.mode === "line") {
			this.current = { x0: 0, y0: y, x1: Math.max(0, lineWidth(line) - 1), y1: y };
			return;
		}
		const w = wordAt(line, x);
		this.current = w ? { x0: w.from, y0: y, x1: w.to - 1, y1: y } : null;
	}

	drag(x: number, y: number): void {
		if (!this.down || this.mode !== "char") return;
		if (!this.moved) {
			if (Math.max(Math.abs(x - this.anchor.x), Math.abs(y - this.anchor.y)) < CLICK_SLOP) return;
			this.moved = true;
		}
		this.current = { x0: this.anchor.x, y0: this.anchor.y, x1: x, y1: y };
	}

	release(x: number, y: number): ReleaseResult {
		if (!this.down) return { kind: "none" };
		this.down = false;
		if (this.mode === "char") {
			if (!this.moved) {
				this.current = null;
				return { kind: "click" };
			}
			this.current = { x0: this.anchor.x, y0: this.anchor.y, x1: x, y1: y };
		}
		if (!this.current) return { kind: "none" };
		const text = extractText(this.read(), this.current);
		if (text.trim().length === 0) {
			this.current = null;
			return { kind: "none" };
		}
		return { kind: "copy", text };
	}

	/** Forget the click history too (tests, teardown). */
	reset(): void {
		this.clear();
		this.lastPress = null;
		this.clicks = 0;
	}

	/** Drop the selection. True when there was one. */
	clear(): boolean {
		const had = this.current !== null;
		this.current = null;
		this.down = false;
		this.moved = false;
		return had;
	}
}

/**
 * Bytes that redraw the rows a selection touched: first each row of `before`
 * and `after` back to its last drawn (styled) form, then the `after` cells in
 * reverse video. Cursor position is saved and restored around it.
 */
export function paintSelection(
	rawFrame: string,
	plainFrame: string,
	before: SelRange | null,
	after: SelRange | null,
): string {
	const raw = rawFrame.split("\n");
	const plain = plainFrame.split("\n");
	const rows = new Set<number>();
	for (const r of [before, after]) {
		if (!r) continue;
		const [a, b] = ordered(r);
		for (let y = a.y; y <= b.y; y++) rows.add(y);
	}
	if (rows.size === 0) return "";
	let out = "\x1b7";
	for (const y of [...rows].sort((p, q) => p - q)) {
		if (y < 0 || y >= raw.length) continue;
		out += `\x1b[${y + 1};1H${raw[y]}\x1b[0m`;
	}
	if (after) {
		const [a, b] = ordered(after);
		for (let y = a.y; y <= b.y; y++) {
			const line = plain[y] ?? "";
			const from = y === a.y ? a.x : 0;
			const to = y === b.y ? b.x + 1 : lineWidth(line);
			const seg = sliceCells(line, from, to).trimEnd();
			if (seg.length > 0) out += `\x1b[${y + 1};${from + 1}H\x1b[7m${seg}\x1b[0m`;
		}
	}
	return `${out}\x1b8`;
}

/** "Copied 12 characters" for the footer. */
export function copiedNotice(chars: number): string {
	return `Copied ${chars} character${chars === 1 ? "" : "s"}`;
}

/** OSC 52: the terminal puts the text on the system clipboard. */
export function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}
