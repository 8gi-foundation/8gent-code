/**
 * 8gent Code - in-process PDF writer for make_pdf (#4267).
 *
 * Markdown (or simple HTML, converted to Markdown blocks) laid out on A4 with
 * the PDF standard fonts (Helvetica, Helvetica-Bold, Helvetica-Oblique,
 * Courier), which every PDF reader carries, so nothing is embedded and nothing
 * outside this file is needed: no weasyprint, no Chrome, no home-dir script.
 *
 * Deterministic: the same input gives byte-identical output (no dates, no ids).
 * Text is WinAnsi encoded; characters outside it (emoji, CJK) become "?" and
 * are counted, so the caller can say so rather than hide it.
 */

type Kind = "h1" | "h2" | "h3" | "p" | "li" | "quote" | "code" | "hr";
export interface Block {
	kind: Kind;
	text: string;
	marker?: string;
}

// ---------- Markdown to blocks ----------

function inline(s: string): string {
	return s
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image: $1]")
		.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, "$1 ($2)")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, "$1$2")
		.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1")
		.trim();
}

export function parseMarkdown(md: string): Block[] {
	const out: Block[] = [];
	const lines = md.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
	let para: string[] = [];
	const flush = () => {
		if (para.length) out.push({ kind: "p", text: inline(para.join(" ")) });
		para = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = line.match(/^\s*(```|~~~)/);
		if (fence) {
			flush();
			const body: string[] = [];
			while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i]);
			out.push({ kind: "code", text: body.join("\n") });
			continue;
		}
		let m: RegExpMatchArray | null;
		if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
			flush();
			const n = m[1].length;
			out.push({ kind: n === 1 ? "h1" : n === 2 ? "h2" : "h3", text: inline(m[2]) });
		} else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			out.push({ kind: "hr", text: "" });
		} else if ((m = line.match(/^\s*([-*+]|\d{1,4}[.)])\s+(.*)$/))) {
			flush();
			const item = [m[2]];
			while (
				i + 1 < lines.length &&
				/^\s{2,}\S/.test(lines[i + 1]) &&
				!/^\s*([-*+]|\d{1,4}[.)])\s/.test(lines[i + 1])
			)
				item.push(lines[++i].trim());
			out.push({
				kind: "li",
				text: inline(item.join(" ")),
				marker: /\d/.test(m[1]) ? m[1].replace(")", ".") : "\u2022",
			});
		} else if ((m = line.match(/^\s*>\s?(.*)$/))) {
			flush();
			out.push({ kind: "quote", text: inline(m[1]) });
		} else if (/^\s*\|/.test(line)) {
			flush();
			const rows: string[] = [];
			for (; i < lines.length && /^\s*\|/.test(lines[i]); i++)
				if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i])) rows.push(lines[i].trim());
			i--;
			if (rows.length) out.push({ kind: "code", text: rows.join("\n") });
		} else if (line.trim() === "") {
			flush();
		} else {
			para.push(line.trim());
		}
	}
	flush();
	return out.filter((b) => b.kind === "hr" || b.kind === "code" || b.text !== "");
}

// ---------- HTML to Markdown (structure only; CSS is not applied) ----------

// biome-ignore format: lookup table kept on one line
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", bull: "\u2022", copy: "\u00a9", euro: "\u20ac" };
function decode(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
		if (e[0] === "#") {
			const cp =
				e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
			return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : all;
		}
		return ENTITIES[e.toLowerCase()] ?? all;
	});
}

export function htmlToMarkdown(html: string): string {
	// Entities are decoded once, after the last tag strip, so "&lt;b&gt;" stays text.
	const text = (s: string) =>
		s
			.replace(/<[^>]*>/g, "")
			.replace(/\s+/g, " ")
			.trim();
	return decode(
		html
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/<(script|style|head|title|svg)\b[\s\S]*?<\/\1>/gi, "")
			.replace(
				/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
				(_, b: string) => `\n\n\`\`\`\n${b.replace(/<[^>]*>/g, "")}\n\`\`\`\n\n`,
			)
			.replace(
				/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
				(_, n: string, b: string) => `\n\n${"#".repeat(Number(n))} ${text(b)}\n\n`,
			)
			.replace(
				/<li\b[^>]*>([\s\S]*?)(<\/li>|(?=<li\b)|(?=<\/[ou]l>))/gi,
				(_, b: string) => `\n- ${text(b)}\n`,
			)
			.replace(
				/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
				(_, b: string) => `\n\n> ${text(b)}\n\n`,
			)
			.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|section|article|header|footer|tr|table|ul|ol|main)>/gi, "\n\n")
			.replace(/<[^>]*>/g, ""),
	);
}

// ---------- Fonts and encoding ----------

// Adobe AFM advance widths (1/1000 em) for WinAnsi 0x20..0x7E.
// biome-ignore format: lookup table kept on one line
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// biome-ignore format: lookup table kept on one line
const BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
// biome-ignore format: lookup table kept on one line
const HIGH: Record<number, number> = { 128: 556, 133: 1000, 145: 222, 146: 222, 147: 333, 148: 333, 149: 350, 150: 556, 151: 1000, 160: 278 };
// Unicode code points WinAnsi places in 0x80..0x9F.
// biome-ignore format: lookup table kept on one line
const WIN: Record<number, number> = { 8364: 0x80, 8218: 0x82, 402: 0x83, 8222: 0x84, 8230: 0x85, 8224: 0x86, 8225: 0x87, 710: 0x88, 8240: 0x89, 352: 0x8a, 8249: 0x8b, 338: 0x8c, 381: 0x8e, 8216: 0x91, 8217: 0x92, 8220: 0x93, 8221: 0x94, 8226: 0x95, 8211: 0x96, 8212: 0x97, 732: 0x98, 8482: 0x99, 353: 0x9a, 8250: 0x9b, 339: 0x9c, 382: 0x9e, 376: 0x9f };

type Font = "F1" | "F2" | "F3" | "F4"; // Helvetica, Bold, Courier, Oblique

/** Encode to WinAnsi bytes; unmappable characters become "?" and are counted. */
export function winAnsi(s: string, tally: { replaced: number }): number[] {
	const bytes: number[] = [];
	for (const ch of s.normalize("NFC")) {
		const cp = ch.codePointAt(0) as number;
		if (cp >= 0x20 && cp <= 0x7e) bytes.push(cp);
		else if (cp >= 0xa0 && cp <= 0xff) bytes.push(cp);
		else if (WIN[cp] !== undefined) bytes.push(WIN[cp]);
		else if (cp === 0x0a || cp === 0x0d) bytes.push(0x20);
		else {
			bytes.push(0x3f);
			tally.replaced++;
		}
	}
	return bytes;
}

/** Width of one byte in font units (1/1000 of the size). */
function unit(b: number, font: Font): number {
	if (font === "F3") return 600;
	const t = font === "F2" ? BOLD : HELV;
	return b >= 0x20 && b <= 0x7e ? t[b - 0x20] : (HIGH[b] ?? (font === "F2" ? 611 : 556));
}

function width(bytes: number[], font: Font, size: number): number {
	let w = 0;
	for (const b of bytes) w += unit(b, font);
	return w * (size / 1000);
}

/**
 * Greedy word wrap; a word wider than the line is split by characters. The
 * split keeps a running width, so a long word costs time in line with its
 * length (it used to re-measure every prefix: an 8000-character word took
 * 2.7 s). Units are summed in the same order as width(), so every break lands
 * where it did before.
 */
function wrap(bytes: number[], font: Font, size: number, max: number): number[][] {
	const lines: number[][] = [];
	let line: number[] = [];
	const words: number[][] = [];
	let cur: number[] = [];
	for (const b of bytes) {
		if (b === 0x20) {
			if (cur.length) words.push(cur);
			cur = [];
		} else cur.push(b);
	}
	if (cur.length) words.push(cur);
	const scale = size / 1000;
	for (const word of words) {
		const tryLine = line.length ? [...line, 0x20, ...word] : word;
		if (width(tryLine, font, size) <= max) {
			line = tryLine;
			continue;
		}
		if (line.length) lines.push(line);
		// Split the word: each piece is the longest prefix that fits (at least
		// one character); the remainder that fits becomes the open line.
		let start = 0;
		let w = 0;
		for (let i = 0; i < word.length; i++) {
			const next = w + unit(word[i], font);
			if (i > start && next * scale > max) {
				lines.push(word.slice(start, i));
				start = i;
				w = unit(word[i], font);
			} else w = next;
		}
		line = word.slice(start);
	}
	if (line.length) lines.push(line);
	return lines;
}

// ---------- Layout and serialisation ----------

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const TEXT_W = PAGE_W - 2 * MARGIN;
export const MAX_PAGES = 500;

const STYLE: Record<
	Exclude<Kind, "hr">,
	{ font: Font; size: number; lead: number; before: number; after: number; indent: number }
> = {
	h1: { font: "F2", size: 20, lead: 25, before: 10, after: 6, indent: 0 },
	h2: { font: "F2", size: 15, lead: 19, before: 10, after: 4, indent: 0 },
	h3: { font: "F2", size: 12, lead: 16, before: 8, after: 2, indent: 0 },
	p: { font: "F1", size: 11, lead: 15, before: 0, after: 7, indent: 0 },
	li: { font: "F1", size: 11, lead: 15, before: 0, after: 3, indent: 16 },
	quote: { font: "F4", size: 11, lead: 15, before: 4, after: 7, indent: 16 },
	code: { font: "F3", size: 9, lead: 12, before: 2, after: 8, indent: 6 },
};

const pdfStr = (bytes: number[]) =>
	`(${bytes.map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join("")})`;

export interface WriteResult {
	pdf: Buffer;
	pages: number;
	replaced: number;
}

/** Lay blocks out on A4 pages and serialise a complete PDF 1.4 file. */
export function writePdf(blocks: Block[], title?: string): WriteResult {
	const tally = { replaced: 0 };
	const pages: string[][] = [[]];
	let y = PAGE_H - MARGIN;
	const newPage = () => {
		if (pages.length >= MAX_PAGES)
			throw new Error(`document is over ${MAX_PAGES} pages; split it into smaller PDFs`);
		pages.push([]);
		y = PAGE_H - MARGIN;
	};
	const ops = () => pages[pages.length - 1];
	const room = (h: number) => {
		if (y - h < MARGIN + 18) newPage();
	};
	const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

	for (const b of blocks) {
		if (b.kind === "hr") {
			room(14);
			y -= 7;
			ops().push(`0.75 G 0.6 w ${MARGIN} ${fmt(y)} m ${PAGE_W - MARGIN} ${fmt(y)} l S`);
			y -= 7;
			continue;
		}
		const s = STYLE[b.kind];
		const atTop = y === PAGE_H - MARGIN;
		if (!atTop) y -= s.before;
		const raw = b.kind === "code" ? b.text.split("\n") : [b.text];
		const lines: number[][] = [];
		const avail = TEXT_W - s.indent;
		for (const r of raw) {
			const bytes = winAnsi(r, tally);
			if (b.kind === "code") {
				const per = Math.max(1, Math.floor(avail / (0.6 * s.size)));
				if (bytes.length === 0) lines.push([]);
				for (let i = 0; i < bytes.length; i += per) lines.push(bytes.slice(i, i + per));
			} else lines.push(...wrap(bytes, s.font, s.size, avail));
		}
		// Keep a heading with at least two lines of what follows.
		if (b.kind.startsWith("h")) room(s.lead * lines.length + 30);
		lines.forEach((ln, i) => {
			room(s.lead);
			y -= s.lead;
			const x = MARGIN + s.indent;
			if (b.kind === "li" && i === 0 && b.marker) {
				const mk = winAnsi(b.marker, tally);
				ops().push(
					`BT /F1 ${s.size} Tf ${fmt(x - 4 - width(mk, "F1", s.size))} ${fmt(y)} Td ${pdfStr(mk)} Tj ET`,
				);
			}
			if (ln.length)
				ops().push(`BT /${s.font} ${s.size} Tf ${fmt(x)} ${fmt(y)} Td ${pdfStr(ln)} Tj ET`);
		});
		y -= s.after;
	}

	const n = pages.length;
	// Objects: 1 catalog, 2 pages, 3-6 fonts, 7 info, then a page and a content stream per page.
	const objs: string[] = [];
	const kids = pages.map((_, i) => `${8 + i * 2} 0 R`).join(" ");
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
	for (const base of ["Helvetica", "Helvetica-Bold", "Courier", "Helvetica-Oblique"])
		objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
	const info = title ? `/Title ${pdfStr(winAnsi(title, { replaced: 0 }))} ` : "";
	objs.push(`<< ${info}/Producer (8gent Code make_pdf) >>`);
	pages.forEach((p, i) => {
		const footer = winAnsi(`${i + 1} / ${n}`, tally);
		const body = [
			...p,
			`0 g BT /F1 9 Tf ${fmt(PAGE_W / 2 - width(footer, "F1", 9) / 2)} 30 Td ${pdfStr(footer)} Tj ET`,
		].join("\n");
		objs.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${9 + i * 2} 0 R >>`,
		);
		objs.push(`<< /Length ${Buffer.byteLength(body, "latin1")} >>\nstream\n${body}\nendstream`);
	});

	let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(Buffer.byteLength(out, "latin1"));
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return { pdf: Buffer.from(out, "latin1"), pages: n, replaced: tally.replaced };
}
