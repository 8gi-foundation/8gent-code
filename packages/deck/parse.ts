/**
 * 8gent Code - Marp deck parsing and narration text.
 *
 * Pure functions, no I/O. Same input, same slides, same narration: the video
 * render path depends on that, so nothing here may read the clock, the
 * environment, or a model.
 */

export interface DeckSlide {
	/** 1-based position in the deck. */
	index: number;
	/** Slide markdown with directive and note comments removed. */
	markdown: string;
	/** Speaker notes (`<!-- ... -->` comments that are not Marp directives). */
	notes: string[];
}

export interface ParsedDeck {
	/** Raw front matter body (between the opening and closing `---`), or "". */
	frontMatter: string;
	slides: DeckSlide[];
}

const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Marp directive keys. A comment made only of these is config, not a note. */
const DIRECTIVE_KEYS = new Set([
	"marp",
	"theme",
	"style",
	"headingDivider",
	"size",
	"math",
	"title",
	"description",
	"author",
	"image",
	"keywords",
	"url",
	"lang",
	"paginate",
	"header",
	"footer",
	"class",
	"backgroundColor",
	"backgroundImage",
	"backgroundPosition",
	"backgroundRepeat",
	"backgroundSize",
	"color",
	"transition",
]);

/**
 * Directives only Marp uses. Blog-style keys (title, author, description...)
 * are left out so an ordinary markdown post never counts as a deck.
 */
const MARP_ONLY_KEYS = [
	"theme",
	"paginate",
	"headingDivider",
	"size",
	"class",
	"backgroundColor",
	"backgroundImage",
	"color",
	"transition",
];

/**
 * True when the markdown is a Marp deck: front matter with `marp: true`, or
 * front matter carrying a Marp-only directive on a file that splits into at
 * least two slides. Local models often write `theme:` and `paginate:` but
 * forget `marp: true` (Rishi pilot, 2026-09-29). An explicit `marp: false`
 * always opts out.
 */
export function isMarpDeck(content: string): boolean {
	const m = FRONT_MATTER.exec(content);
	if (!m) return false;
	const fm = m[1];
	const flag = /^[ \t]*marp[ \t]*:[ \t]*(true|false)[ \t]*$/m.exec(fm);
	if (flag) return flag[1] === "true";
	const hasMarpKey = MARP_ONLY_KEYS.some((k) => new RegExp(`^[ \\t]*${k}[ \\t]*:`, "m").test(fm));
	return hasMarpKey && parseDeck(content).slides.length >= 2;
}

function isFenceLine(line: string): string | null {
	const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
	return m ? m[1] : null;
}

/**
 * A `---` directly under a line of paragraph text is a setext heading
 * underline in CommonMark, not a slide break. Anything else ends the slide.
 */
function isParagraphText(line: string): boolean {
	const t = line.trim();
	if (t === "") return false;
	if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|<!--)/.test(t)) return false;
	return true;
}

function isDirectiveComment(body: string): boolean {
	const lines = body
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return true;
	return lines.every((l) => {
		const m = /^_?([A-Za-z]+)\s*:/.exec(l);
		return m !== null && DIRECTIVE_KEYS.has(m[1]);
	});
}

function splitComments(markdown: string): { markdown: string; notes: string[] } {
	const notes: string[] = [];
	const out: string[] = [];
	let fence: string | null = null;
	const lines = markdown.split("\n");
	let buffer = "";
	let inComment = false;
	for (const line of lines) {
		if (!inComment) {
			const f = isFenceLine(line);
			if (fence) {
				if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
				out.push(line);
				continue;
			}
			if (f) {
				fence = f;
				out.push(line);
				continue;
			}
		}
		let rest = line;
		let kept = "";
		while (rest.length > 0) {
			if (inComment) {
				const end = rest.indexOf("-->");
				if (end === -1) {
					buffer += `${rest}\n`;
					rest = "";
				} else {
					buffer += rest.slice(0, end);
					const body = buffer.trim();
					if (!isDirectiveComment(body)) notes.push(body.replace(/\s+/g, " ").trim());
					buffer = "";
					inComment = false;
					rest = rest.slice(end + 3);
				}
			} else {
				const start = rest.indexOf("<!--");
				if (start === -1) {
					kept += rest;
					rest = "";
				} else {
					kept += rest.slice(0, start);
					inComment = true;
					rest = rest.slice(start + 4);
				}
			}
		}
		if (!(kept.trim() === "" && line.trim() !== "")) out.push(kept);
	}
	return { markdown: out.join("\n").trim(), notes: notes.filter(Boolean) };
}

/** Split a Marp deck into slides. Front matter is removed. */
export function parseDeck(content: string): ParsedDeck {
	let text = content.replace(/\r\n?/g, "\n");
	let frontMatter = "";
	const m = FRONT_MATTER.exec(text);
	if (m) {
		frontMatter = m[1];
		text = text.slice(m[0].length);
	}
	const chunks: string[][] = [[]];
	let fence: string | null = null;
	for (const line of text.split("\n")) {
		const f = isFenceLine(line);
		if (fence) {
			if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
			chunks[chunks.length - 1].push(line);
			continue;
		}
		if (f) {
			fence = f;
			chunks[chunks.length - 1].push(line);
			continue;
		}
		if (/^---[ \t]*$/.test(line)) {
			const cur = chunks[chunks.length - 1];
			const prev = cur.length > 0 ? cur[cur.length - 1] : "";
			if (!isParagraphText(prev)) {
				chunks.push([]);
				continue;
			}
		}
		chunks[chunks.length - 1].push(line);
	}
	const slides: DeckSlide[] = [];
	for (const chunk of chunks) {
		const { markdown, notes } = splitComments(chunk.join("\n"));
		if (markdown === "" && notes.length === 0) continue;
		slides.push({ index: slides.length + 1, markdown, notes });
	}
	return { frontMatter, slides };
}

/** Inline markdown to plain text for speech. */
export function plainInline(text: string): string {
	// Code spans are lifted out first so emphasis rules never touch them.
	const spans: string[] = [];
	const lifted = text.replace(/`([^`]*)`/g, (_m, code: string) => {
		spans.push(code);
		return `\uE000${spans.length - 1}\uE000`;
	});
	return lifted
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/(^|[^\w])__(.+?)__(?!\w)/g, "$1$2")
		.replace(/\*(.+?)\*/g, "$1")
		.replace(/(^|[^\w])_(.+?)_(?!\w)/g, "$1$2")
		.replace(/<[^>]+>/g, "")
		.replace(/\uE000(\d+)\uE000/g, (_m, n: string) => spans[Number(n)] ?? "")
		.replace(/\s*\u2014\s*/g, ", ")
		.replace(/(\d)\s*\u2013\s*(\d)/g, "$1 to $2")
		.replace(/\s*\u2013\s*/g, ", ")
		.replace(/\s*(\u2192|->)\s*/g, " to ")
		.replace(/\s*(\u2190|<-)\s*/g, " from ")
		.replace(/\s+/g, " ")
		.trim();
}

function sentence(text: string): string {
	const t = text.trim();
	if (t === "") return "";
	return /[.!?:;]$/.test(t) ? t : `${t}.`;
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => plainInline(c));
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * The words spoken over a slide. Speaker notes win. Otherwise a fixed plain
 * reading: headings, paragraphs and list items in order, each table row read
 * as "first cell: header value; header value", and each code block replaced
 * by "Code example."
 */
export function slideNarration(slide: DeckSlide): string {
	if (slide.notes.length > 0) return slide.notes.map(sentence).join(" ");
	const parts: string[] = [];
	const lines = slide.markdown.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const f = isFenceLine(line);
		if (f) {
			i++;
			while (i < lines.length) {
				const g = isFenceLine(lines[i]);
				i++;
				if (g && g[0] === f[0] && g.length >= f.length) break;
			}
			parts.push("Code example.");
			continue;
		}
		if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
			const header = tableCells(line);
			i += 2;
			while (i < lines.length && /^\s*\|/.test(lines[i])) {
				const cells = tableCells(lines[i]);
				const first = cells[0] ?? "";
				const rest = cells
					.slice(1)
					.map((c, k) => (header[k + 1] ? `${header[k + 1]} ${c}` : c))
					.filter((c) => c.trim() !== "");
				parts.push(sentence(rest.length ? `${first}: ${rest.join("; ")}` : first));
				i++;
			}
			continue;
		}
		const t = line.trim();
		i++;
		if (t === "") continue;
		const body = t
			.replace(/^#{1,6}\s+/, "")
			.replace(/^[-*+]\s+/, "")
			.replace(/^\d+[.)]\s+/, "")
			.replace(/^>\s?/, "");
		const said = sentence(plainInline(body));
		if (said) parts.push(said);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}
