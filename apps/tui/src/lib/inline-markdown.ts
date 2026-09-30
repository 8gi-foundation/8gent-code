/**
 * Inline markdown for chat replies: the small subset a reply actually uses.
 *
 * Pure functions, no React or Ink. The renderer in message-list.tsx draws
 * these blocks and the row estimator counts them with the same widths, so
 * the chat's row budget and what Ink draws agree.
 *
 * Supported, and nothing else:
 * - `code` spans: a chip (a background tint with a space either side), or
 *   the backticks kept when the terminal draws no colour at all.
 * - **bold** and __bold__, which may hold code spans, and *italic* (single
 *   stars only: snake_case and `2 * 3` stay as written).
 * - `# heading` lines, drawn bold.
 * - `-`, `*`, `+` and `1.` list items with a hanging indent, nested by
 *   two-space steps, with lazy continuation lines.
 * - ``` fences, drawn as a plain block behind a thin rule so code keeps its
 *   indentation and stays readable at 80 columns. An unclosed fence (a reply
 *   still streaming) runs to the end.
 *
 * Anything this does not recognise stays as the literal text.
 */

export interface Span {
	text: string;
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
}

export type Block =
	| { kind: "para"; spans: Span[]; heading?: boolean; keepSpaces?: boolean }
	| { kind: "item"; depth: number; marker: string; spans: Span[] }
	| { kind: "code"; lang: string; lines: string[] }
	| { kind: "blank" };

export interface MarkdownOptions {
	/** Draw code spans as tinted chips; false keeps the backticks. */
	chips?: boolean;
	/** Bullet glyph for unordered items ("•", or "-" on plain terminals). */
	bullet?: string;
}

/** Deepest list nesting drawn; deeper items sit at this depth. */
const MAX_DEPTH = 3;
/** Columns one nesting step indents. */
export const INDENT_STEP = 2;
/** Columns the thin rule in front of a code block takes ("│ "). */
export const CODE_GUTTER = 2;

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
/** Two or more leading spaces (not a list item, not a fence): hand-aligned text. */
const INDENTED = /^ {2,}\S/;
// A code span, or a bold run. Code is matched first at any position, so a
// backtick inside ** ** still becomes a chip (parsed in the bold's own pass).
const INLINE =
	/(`+)([^`]+?)\1|\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*|__(?=\S)([\s\S]+?)(?<=\S)__|(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![\w*])/g;

/** Inline spans for one run of text. Unmatched markers stay literal. */
export function parseInline(
	text: string,
	opts: MarkdownOptions = {},
	bold = false,
	italic = false,
): Span[] {
	const chips = opts.chips ?? true;
	const out: Span[] = [];
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		const at = m.index ?? 0;
		if (at > last) push(out, { text: text.slice(last, at), bold, italic });
		if (m[2] !== undefined) {
			const code = m[2].trim() || m[2];
			push(out, chips ? { text: ` ${code} `, code: true, bold } : { text: `\`${code}\``, bold });
		} else if (m[5] !== undefined) {
			for (const s of parseInline(m[5], opts, bold, true)) push(out, s);
		} else {
			const inner = m[3] ?? m[4] ?? "";
			for (const s of parseInline(inner, opts, true, italic)) push(out, s);
		}
		last = at + m[0].length;
	}
	if (last < text.length) push(out, { text: text.slice(last), bold, italic });
	return out;
}

function push(out: Span[], span: Span) {
	if (!span.text) return;
	const prev = out[out.length - 1];
	if (
		prev &&
		!prev.code &&
		!span.code &&
		Boolean(prev.bold) === Boolean(span.bold) &&
		Boolean(prev.italic) === Boolean(span.italic)
	) {
		prev.text += span.text;
		return;
	}
	const clean: Span = { text: span.text };
	if (span.bold) clean.bold = true;
	if (span.italic) clean.italic = true;
	if (span.code) clean.code = true;
	out.push(clean);
}

/** The text a run of spans draws, chips' padding included. */
export function spanText(spans: Span[]): string {
	return spans.map((s) => s.text).join("");
}

/** The words a span stands for: a chip without its padding. */
function wordsOf(span: Span): string {
	return span.code ? span.text.slice(1, -1) : span.text;
}

/**
 * A line of agent text with its inline markers taken out: `code` becomes
 * code, **bold** becomes bold. For places too narrow for a chip (the PLAN
 * column, the TASKS rail), where a literal backtick is noise, not meaning.
 */
export function plainInline(text: string): string {
	return parseInline(text, { chips: true })
		.map(wordsOf)
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Cut a run of spans to `width` columns, counting a chip's padding. The cut
 * lands inside the span that overflows and ends in "…"; a chip keeps its
 * padding either side, so a cut path still reads as a chip.
 */
export function clipSpans(spans: ReadonlyArray<Span>, width: number): Span[] {
	const out: Span[] = [];
	let room = Math.max(0, width);
	for (const span of spans) {
		const chars = [...span.text];
		if (chars.length <= room) {
			out.push({ ...span });
			room -= chars.length;
			continue;
		}
		if (room <= 0) break;
		if (span.code && room >= 4) {
			const inner = [...wordsOf(span)].slice(0, room - 3).join("");
			out.push({ ...span, text: ` ${inner}… ` });
		} else if (span.code) {
			out.push({ text: "…" });
		} else {
			out.push({ ...span, text: `${chars.slice(0, room - 1).join("")}…` });
		}
		break;
	}
	return out;
}

/** Split a reply into blocks. */
export function parseBlocks(content: string, opts: MarkdownOptions = {}): Block[] {
	const bullet = opts.bullet ?? "•";
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	// Raw text of the list item still collecting continuation lines.
	let open: { depth: number; marker: string; text: string } | null = null;
	const closeItem = () => {
		if (!open) return;
		blocks.push({ kind: "item", depth: open.depth, marker: open.marker, spans: parseInline(open.text, opts) });
		open = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = line.match(FENCE);
		if (fence) {
			closeItem();
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			blocks.push({ kind: "code", lang: fence[1] ?? "", lines: body.length ? body : [""] });
			continue;
		}
		if (!line.trim()) {
			closeItem();
			// Runs of blank lines draw as one.
			if (blocks.length && blocks[blocks.length - 1].kind !== "blank") blocks.push({ kind: "blank" });
			continue;
		}
		const item = line.match(ITEM);
		if (item) {
			closeItem();
			const depth = Math.min(MAX_DEPTH, Math.floor(item[1].replace(/\t/g, "  ").length / INDENT_STEP));
			const marker = /^\d/.test(item[2]) ? item[2].replace(")", ".") : bullet;
			open = { depth, marker, text: item[3] };
			continue;
		}
		const heading = line.match(HEADING);
		if (heading) {
			closeItem();
			blocks.push({ kind: "para", heading: true, spans: parseInline(heading[1], opts, true) });
			continue;
		}
		if (open) {
			// Lazy continuation: the line belongs to the item above it.
			open.text += ` ${line.trim()}`;
			continue;
		}
		// A line that starts indented is laid out by hand (label/value
		// columns, a hanging list of values): it keeps its spaces.
		if (INDENTED.test(line)) {
			blocks.push({ kind: "para", keepSpaces: true, spans: parseInline(line, opts) });
			continue;
		}
		blocks.push({ kind: "para", spans: parseInline(line, opts) });
	}
	closeItem();
	// A trailing blank row is padding nobody asked for.
	while (blocks.length && blocks[blocks.length - 1].kind === "blank") blocks.pop();
	while (blocks.length && blocks[0].kind === "blank") blocks.shift();
	return blocks;
}

/** True when the reply uses anything this renderer draws differently. */
export function hasMarkdown(content: string): boolean {
	return /`|\*|__|^\s*([-*+]|\d{1,3}[.)])\s|^#{1,6}\s/m.test(content);
}

/** Marker column width for a list item: the marker plus one space. */
export function markerWidth(marker: string): number {
	return [...marker].length + 1;
}

/**
 * Cut a word too long for a row, preferring the seams a path or a compound
 * has (-, /, _, .), and only then the row edge.
 */
export function chunkWord(word: string, width: number): string[] {
	const w = Math.max(1, width);
	const out: string[] = [];
	let buf = "";
	for (let part of word.split(/(?<=[-/_.])/)) {
		if ([...buf].length + [...part].length <= w) {
			buf += part;
			continue;
		}
		if (buf) out.push(buf);
		buf = "";
		while ([...part].length > w) {
			out.push([...part].slice(0, w).join(""));
			part = [...part].slice(w).join("");
		}
		buf = part;
	}
	if (buf) out.push(buf);
	return out.length ? out : [""];
}

/**
 * Lay a run of spans out into rows no wider than `width`, the way the
 * reply is drawn. Words move to the next row whole; a code chip is one unit,
 * so it is never split across rows unless it is wider than a row itself; a
 * wrapped row never starts with a space (audit #12). Ink then draws each row
 * as it is, so the row count here is the row count on screen.
 *
 * `keepSpaces` is for hand-aligned lines (an indented label/value row): the
 * indent and every run of spaces are kept as written, so columns line up
 * (audit 2026-09-30, #6). A run that would start a wrapped row is dropped.
 */
export function layoutLines(spans: Span[], width: number, keepSpaces = false): Span[][] {
	const w = Math.max(1, width);
	if (keepSpaces) return layoutKeepingSpaces(spans, w);
	type Tok = Span & { sp: boolean };
	const toks: Tok[] = [];
	let pendingSpace = false;
	for (const span of spans) {
		if (span.code) {
			toks.push({ ...span, sp: pendingSpace });
			pendingSpace = false;
			continue;
		}
		for (const part of span.text.split(/( +)/)) {
			if (!part) continue;
			if (part.startsWith(" ")) {
				pendingSpace = true;
				continue;
			}
			toks.push({ text: part, bold: span.bold, italic: span.italic, sp: pendingSpace });
			pendingSpace = false;
		}
	}

	const lines: Span[][] = [[]];
	let col = 0;
	const put = (span: Span) => {
		push(lines[lines.length - 1], span);
		col += [...span.text].length;
	};
	const newline = () => {
		lines.push([]);
		col = 0;
	};

	// Tokens with no space between them ("package.json" and the "." after
	// its chip) are one group, so punctuation never lands alone on a row.
	const groups: Tok[][] = [];
	for (const tok of toks) {
		if (!tok.sp && groups.length) groups[groups.length - 1].push(tok);
		else groups.push([tok]);
	}
	const groupWidth = (g: Tok[]) => g.reduce((n, t) => n + [...t.text].length, 0);
	const place = (tok: Tok, first: boolean) => {
		const piece: Span = { text: tok.text, bold: tok.bold, italic: tok.italic, code: tok.code };
		const len = [...tok.text].length;
		const gap = first && col > 0 && tok.sp ? 1 : 0;
		if (col + gap + len <= w) {
			if (gap) put({ text: " ", bold: tok.bold, italic: tok.italic });
			put(piece);
			return;
		}
		if (col > 0) newline();
		if (len <= w) {
			put(piece);
			return;
		}
		chunkWord(tok.text, w).forEach((text, i) => {
			if (i > 0) newline();
			put({ ...piece, text });
		});
	};
	for (const group of groups) {
		const len = groupWidth(group);
		const gap = col > 0 && group[0].sp ? 1 : 0;
		// The whole group moves down when it fits a row but not this one.
		if (col > 0 && col + gap + len > w && len <= w) newline();
		group.forEach((tok, i) => place(tok, i === 0));
	}
	return lines;
}

/** layoutLines for a hand-aligned line: spaces kept, words never split unless wider than a row. */
function layoutKeepingSpaces(spans: Span[], w: number): Span[][] {
	const lines: Span[][] = [[]];
	let col = 0;
	for (const span of spans) {
		const parts = span.code ? [span.text] : span.text.split(/( +)/).filter(Boolean);
		for (const part of parts) {
			const space = !span.code && part.startsWith(" ");
			let len = [...part].length;
			if (col + len > w && col > 0) {
				lines.push([]);
				col = 0;
				if (space) continue;
			}
			const pieces = len > w ? chunkWord(part, w) : [part];
			pieces.forEach((text, i) => {
				if (i > 0) {
					lines.push([]);
					col = 0;
				}
				const piece: Span = { ...span, text };
				push(lines[lines.length - 1], piece);
				len = [...text].length;
				col += len;
			});
		}
	}
	// A row that wrapped keeps no trailing run of spaces.
	for (const row of lines) {
		const last = row[row.length - 1];
		if (last && !last.code) last.text = last.text.replace(/ +$/, "");
		if (last && !last.text) row.pop();
	}
	return lines;
}

/** Text width a block's words wrap at, inside a column `width` wide. */
export function blockWrapWidth(block: Block, width: number): number {
	if (block.kind === "item") return Math.max(4, width - block.depth * INDENT_STEP - markerWidth(block.marker));
	if (block.kind === "code") return Math.max(4, width - CODE_GUTTER);
	return Math.max(1, width);
}

/** Rows one block draws in a column `width` wide. */
export function blockRows(block: Block, width: number): number {
	switch (block.kind) {
		case "blank":
			return 1;
		case "code": {
			const w = blockWrapWidth(block, width);
			const body = block.lines.reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / w)), 0);
			return body + (block.lang ? 1 : 0);
		}
		default:
			return layoutLines(block.spans, blockWrapWidth(block, width), block.kind === "para" && block.keepSpaces)
				.length;
	}
}

/** Rows a whole reply draws in a column `width` wide. */
export function markdownRows(content: string, width: number, opts: MarkdownOptions = {}): number {
	const blocks = parseBlocks(content, opts);
	if (blocks.length === 0) return 1;
	return blocks.reduce((n, b) => n + blockRows(b, width), 0);
}
