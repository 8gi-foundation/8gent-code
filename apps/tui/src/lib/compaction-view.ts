/**
 * The compaction row and the /compact reports (#4958). Pure text, so the row's
 * height is known before it is drawn and the chat's row budget never guesses.
 */

import { fmtTokens } from "./context-view.js";

/** What a compaction left behind, as the chat row keeps it. */
export interface CompactionNote {
	tokensBefore: number;
	tokensAfter: number;
	messagesRemoved: number;
	summary: string;
	filesRead: string[];
	filesModified: string[];
	/** The summary is open. Toggled by a tap or /compact show. */
	expanded: boolean;
}

/** Below this the row is two short lines. */
export const COMPACTION_NARROW_COLS = 60;
/** An open summary shows at most this many lines, then says how many are left. */
export const COMPACTION_MAX_SUMMARY_LINES = 40;

/** Under this many columns the headline drops "from", so it fits beside its marker. */
const HEADLINE_FULL_COLS = 36;

export function compactionHeadline(
	n: Pick<CompactionNote, "tokensBefore" | "tokensAfter">,
	width = 100,
): string {
	const a = fmtTokens(n.tokensBefore);
	const b = fmtTokens(n.tokensAfter);
	return width < HEADLINE_FULL_COLS
		? `Compacted ${a} to ${b} tokens`
		: `Compacted from ${a} to ${b} tokens`;
}

/** Word-wrap one paragraph to `width` cells; a word longer than the width is cut. */
function wrap(text: string, width: number): string[] {
	const w = Math.max(8, width);
	const out: string[] = [];
	let line = "";
	const push = () => {
		if (line) out.push(line);
		line = "";
	};
	for (const word of text.split(/\s+/).filter(Boolean)) {
		let rest = word;
		while (rest.length > w) {
			push();
			out.push(rest.slice(0, w));
			rest = rest.slice(w);
		}
		if (!line) line = rest;
		else if (line.length + 1 + rest.length <= w) line += ` ${rest}`;
		else {
			push();
			line = rest;
		}
	}
	push();
	return out;
}

/** The summary as indented lines, blank lines between paragraphs kept, capped. */
function summaryLines(summary: string, width: number): string[] {
	const out: string[] = [];
	for (const para of summary.trim().split(/\n/)) {
		if (!para.trim()) {
			if (out.length > 0 && out.at(-1) !== "") out.push("");
			continue;
		}
		out.push(...wrap(para.trim(), width));
	}
	if (out.length <= COMPACTION_MAX_SUMMARY_LINES) return out;
	const more = out.length - COMPACTION_MAX_SUMMARY_LINES;
	return [...out.slice(0, COMPACTION_MAX_SUMMARY_LINES), `... ${more} more lines`];
}

export interface CompactionLine {
	text: string;
	/** "head" is the headline, "hint" the dim how-to line, "body" the summary. */
	kind: "head" | "hint" | "body";
}

/**
 * The row's lines at `width`. Collapsed: the headline and one hint line.
 * Expanded: the headline, the summary, the files, and how to fold it.
 */
export function compactionLines(n: CompactionNote, width: number): CompactionLine[] {
	const narrow = width < COMPACTION_NARROW_COLS;
	const head: CompactionLine = { text: compactionHeadline(n, width), kind: "head" };
	if (!n.expanded) {
		const detail = narrow
			? "tap to read  /compact undo"
			: `${n.messagesRemoved} messages summarized. Tap or /compact show to read it. /compact undo restores.`;
		return [head, { text: detail, kind: "hint" }];
	}
	const inner = Math.max(8, width - 2);
	const lines: CompactionLine[] = [head];
	for (const l of summaryLines(n.summary || "No summary was kept.", inner)) {
		lines.push({ text: l, kind: "body" });
	}
	if (n.filesRead.length > 0) {
		for (const l of wrap(`read: ${n.filesRead.join(", ")}`, inner))
			lines.push({ text: l, kind: "body" });
	}
	if (n.filesModified.length > 0) {
		for (const l of wrap(`modified: ${n.filesModified.join(", ")}`, inner)) {
			lines.push({ text: l, kind: "body" });
		}
	}
	lines.push({
		text: narrow
			? "tap to fold  /compact undo"
			: "Tap or /compact show to fold. /compact undo restores.",
		kind: "hint",
	});
	return lines;
}

/** Rows the row takes in the chat: its lines and the blank row after it. */
export function compactionRows(n: CompactionNote, width: number): number {
	return compactionLines(n, width).length + 1;
}

/** The /compact answer: real numbers, and the way back. */
export function compactReport(
	n: Pick<CompactionNote, "tokensBefore" | "tokensAfter" | "messagesRemoved">,
): string {
	return `${compactionHeadline(n)} (${n.messagesRemoved} messages summarized). /compact undo restores them.`;
}

export const COMPACT_NOTHING =
	"Nothing to compact yet: the last 8 messages are always kept, and everything is inside them.";

export function undoReport(tokens: number): string {
	return `Compaction undone: the conversation is back to ${fmtTokens(tokens)} tokens.`;
}

export const UNDO_NOTHING =
	"Nothing to undo: no compaction has run in this tab, or it was already undone.";

export const COMPACT_USAGE = "Usage: /compact, /compact show, /compact undo";
