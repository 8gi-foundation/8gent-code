/**
 * 8gent Code - the text of a Word, Excel or PowerPoint file (#4274).
 *
 * read_file on a .docx, .xlsx or .pptx returned zip bytes as text. This walks
 * the document parts and returns what a person would read: headings and
 * paragraphs, table rows, sheet cells (formulas with a leading "="), slide text
 * and speaker notes. Read-only, no macro or external part is ever followed, and
 * the zip reader caps entries and inflated size.
 */

import * as path from "node:path";
import { type ZipReader, readZip } from "./zip";

/** Characters of extracted text returned before a truncation note. */
export const MAX_READ_CHARS = 200_000;

export const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

export function isOfficeFile(p: string): boolean {
	return OFFICE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescape(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
		if (e[0] === "#") {
			const code =
				e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
			return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
		}
		return ENTITIES[e.toLowerCase()] ?? "";
	});
}

interface Tok {
	close: boolean;
	self: boolean;
	name: string;
	attrs: string;
	text?: string;
}

/** Tags and text runs in document order. Comments, CDATA and processing instructions are skipped. */
function* tokens(xml: string): Generator<Tok> {
	const re =
		/<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
	for (let m = re.exec(xml); m; m = re.exec(xml)) {
		if (m[1] !== undefined)
			yield { close: false, self: false, name: "#text", attrs: "", text: m[1] };
		else if (m[3] !== undefined)
			yield { close: m[2] === "/", self: m[5] === "/", name: m[3], attrs: m[4] };
		else if (m[6] !== undefined)
			yield { close: false, self: false, name: "#text", attrs: "", text: unescape(m[6]) };
	}
}

function attr(attrs: string, name: string): string | undefined {
	const m = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, "\\$&")}="([^"]*)"`).exec(attrs);
	return m ? unescape(m[1]) : undefined;
}

/** Relationship id to target path, resolved against the part's folder. */
function relsOf(
	zip: ZipReader,
	part: string,
): Map<string, { target: string; type: string; external: boolean }> {
	const dir = path.posix.dirname(part);
	const relsPath = path.posix.join(dir, "_rels", `${path.posix.basename(part)}.rels`);
	const out = new Map<string, { target: string; type: string; external: boolean }>();
	const xml = zip.text(relsPath);
	if (!xml) return out;
	for (const t of tokens(xml)) {
		if (t.name !== "Relationship" || t.close) continue;
		const id = attr(t.attrs, "Id");
		const target = attr(t.attrs, "Target") ?? "";
		const external = attr(t.attrs, "TargetMode") === "External";
		if (!id) continue;
		const resolved = external
			? target
			: target.startsWith("/")
				? target.slice(1)
				: path.posix.normalize(path.posix.join(dir, target));
		out.set(id, { target: resolved, type: attr(t.attrs, "Type") ?? "", external });
	}
	return out;
}

function docxText(zip: ZipReader): string {
	const xml = zip.text("word/document.xml");
	if (xml === null) throw new Error("not a Word document (no word/document.xml)");
	const out: string[] = [];
	let para = "";
	let style = "";
	let numbered = false;
	let inText = false;
	let row: string[] | null = null;
	let cell: string[] | null = null;
	let depth = 0;
	for (const t of tokens(xml)) {
		if (t.name === "#text") {
			if (inText) para += t.text;
			continue;
		}
		switch (t.name) {
			case "w:tbl":
				depth += t.close ? -1 : 1;
				if (t.close && depth === 0) out.push("");
				break;
			case "w:tr":
				if (!t.close) row = [];
				else if (row) {
					out.push(`| ${row.join(" | ")} |`);
					row = null;
				}
				break;
			case "w:tc":
				if (!t.close) cell = [];
				else if (cell && row) {
					row.push(cell.join(" ").trim());
					cell = null;
				}
				break;
			case "w:p":
				if (t.self) {
					if (!cell) out.push("");
				} else if (!t.close) {
					para = "";
					style = "";
					numbered = false;
				} else if (cell) cell.push(para);
				else {
					const h = /^Heading(\d)$/.exec(style);
					if (h) out.push(`${"#".repeat(Number(h[1]))} ${para}`);
					else if (style === "Title") out.push(`# ${para}`);
					else if (numbered) out.push(`- ${para}`);
					else out.push(para);
				}
				break;
			case "w:pStyle":
				style = attr(t.attrs, "w:val") ?? "";
				break;
			case "w:numPr":
				if (!t.close) numbered = true;
				break;
			case "w:t":
				inText = !t.close && !t.self;
				break;
			case "w:tab":
				para += "\t";
				break;
			case "w:br":
			case "w:cr":
				para += "\n";
				break;
		}
	}
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function xlsxText(zip: ZipReader): string {
	const wb = zip.text("xl/workbook.xml");
	if (wb === null) throw new Error("not an Excel workbook (no xl/workbook.xml)");
	const strings: string[] = [];
	const sst = zip.text("xl/sharedStrings.xml");
	if (sst) {
		let cur: string | null = null;
		let inT = false;
		let inRPh = false;
		for (const t of tokens(sst)) {
			if (t.name === "si") {
				if (!t.close) cur = "";
				else {
					strings.push(cur ?? "");
					cur = null;
				}
			} else if (t.name === "rPh") inRPh = !t.close;
			else if (t.name === "t") inT = !t.close && !t.self;
			else if (t.name === "#text" && inT && !inRPh && cur !== null) cur += t.text;
		}
	}
	const rels = relsOf(zip, "xl/workbook.xml");
	const out: string[] = [];
	for (const t of tokens(wb)) {
		if (t.name !== "sheet" || t.close) continue;
		const name = attr(t.attrs, "name") ?? "Sheet";
		const rid = attr(t.attrs, "r:id");
		const rel = rid ? rels.get(rid) : undefined;
		if (!rel || rel.external) continue;
		const xml = zip.text(rel.target);
		if (xml === null) continue;
		out.push(`## Sheet: ${name}`);
		let row: string[] = [];
		let ref = "";
		let type = "";
		let value = "";
		let formula = "";
		let inline = "";
		let field: "v" | "f" | "t" | "" = "";
		for (const c of tokens(xml)) {
			if (c.name === "#text") {
				if (field === "v") value += c.text;
				else if (field === "f") formula += c.text;
				else if (field === "t") inline += c.text;
				continue;
			}
			if (c.name === "row") {
				if (c.close || c.self) {
					if (row.length) out.push(row.join("\t"));
					row = [];
				} else row = [];
			} else if (c.name === "c") {
				if (!c.close) {
					ref = attr(c.attrs, "r") ?? "";
					type = attr(c.attrs, "t") ?? "";
					value = formula = inline = "";
				}
				if (c.close || c.self) {
					let shown =
						type === "s"
							? (strings[Number(value)] ?? "")
							: type === "inlineStr"
								? inline
								: type === "b"
									? value === "1"
										? "TRUE"
										: "FALSE"
									: value;
					if (formula) shown = `=${formula}${shown ? ` (${shown})` : ""}`;
					if (shown !== "") row.push(`${ref}: ${shown}`);
				}
			} else if (c.name === "v" || c.name === "f" || c.name === "t") {
				field = c.close || c.self ? "" : c.name;
			}
		}
		out.push("");
	}
	return out.join("\n").trim();
}

function pptxText(zip: ZipReader): string {
	const pres = zip.text("ppt/presentation.xml");
	if (pres === null) throw new Error("not a PowerPoint deck (no ppt/presentation.xml)");
	const rels = relsOf(zip, "ppt/presentation.xml");
	const shapeText = (xml: string, skipPlaceholders = false): string[] => {
		const paras: string[] = [];
		let cur = "";
		let inT = false;
		let skip = false;
		let bullet = false;
		for (const t of tokens(xml)) {
			if (t.name === "#text") {
				if (inT && !skip) cur += t.text;
			} else if (t.name === "p:sp" && !t.close) skip = false;
			else if (t.name === "p:ph" && skipPlaceholders) {
				const type = attr(t.attrs, "type");
				if (
					type === "sldImg" ||
					type === "sldNum" ||
					type === "hdr" ||
					type === "ftr" ||
					type === "dt"
				)
					skip = true;
			} else if (t.name === "a:p") {
				if (t.close || t.self) {
					if (cur.trim() && !skip) paras.push(`${bullet ? "- " : ""}${cur.trim()}`);
				}
				cur = "";
				bullet = false;
			} else if (t.name === "a:buChar" || t.name === "a:buAutoNum") bullet = true;
			else if (t.name === "a:t") inT = !t.close && !t.self;
			else if (t.name === "a:br") cur += "\n";
		}
		return paras;
	};
	const out: string[] = [];
	let n = 0;
	for (const t of tokens(pres)) {
		if (t.name !== "p:sldId" || t.close) continue;
		const rid = attr(t.attrs, "r:id");
		const rel = rid ? rels.get(rid) : undefined;
		if (!rel || rel.external) continue;
		const xml = zip.text(rel.target);
		if (xml === null) continue;
		n++;
		out.push(`## Slide ${n}`, ...shapeText(xml));
		for (const r of relsOf(zip, rel.target).values()) {
			if (!r.type.endsWith("/notesSlide") || r.external) continue;
			const notes = zip.text(r.target);
			if (notes) {
				const lines = shapeText(notes, true);
				if (lines.length) out.push(`Notes: ${lines.join("\n")}`);
			}
		}
		out.push("");
	}
	return out.join("\n").trim();
}

/** The readable text of an office file held in memory, by its extension. */
export function officeText(buf: Buffer, ext: string): string {
	const zip = readZip(buf);
	const e = ext.toLowerCase();
	const text =
		e === ".docx"
			? docxText(zip)
			: e === ".xlsx"
				? xlsxText(zip)
				: e === ".pptx"
					? pptxText(zip)
					: "";
	if (text.length <= MAX_READ_CHARS) return text;
	return `${text.slice(0, MAX_READ_CHARS)}\n\n// ... truncated at ${MAX_READ_CHARS} characters.`;
}

/** read_file's answer for an office file: a one-line header, then the text. Never throws. */
export function readOfficeFile(absolutePath: string, buf: Buffer): string {
	const ext = path.extname(absolutePath).toLowerCase();
	try {
		const text = officeText(buf, ext);
		return `// ${path.basename(absolutePath)}: text extracted from the ${ext.slice(1)} file (read-only view; regenerate with make_${ext.slice(1)} to change it)\n\n${text}`;
	} catch (err) {
		return `Error: could not read ${path.basename(absolutePath)} as ${ext.slice(1)}: ${err instanceof Error ? err.message : String(err)}`;
	}
}
