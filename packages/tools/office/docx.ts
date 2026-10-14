/**
 * 8gent Code - make_docx core (#4274).
 *
 * The model writes a JSON spec of blocks; this code writes the WordprocessingML
 * parts and zips them. A4 page, one-inch margins, built-in heading styles so the
 * navigation pane and a table of contents work in Word. Deterministic, no network,
 * never a macro part.
 */

import { z } from "zod";
import { EMU_IN, ImageBox, XML_HEAD, appXml, coreXml, esc, fit, parseSpec } from "./common";
import { type ZipEntry, writeZip } from "./zip";

const text = (max: number) => z.string().max(max);
const cellValue = z.union([text(4000), z.number(), z.boolean(), z.null()]);

export const DocxBlockSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("heading"),
			text: text(500),
			level: z.number().int().min(1).max(3).optional(),
		})
		.strict(),
	z.object({ type: z.literal("paragraph"), text: text(20000) }).strict(),
	z
		.object({
			type: z.literal("bullets"),
			items: z.array(text(4000)).min(1).max(500),
			numbered: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("table"),
			rows: z.array(z.array(cellValue).max(30)).min(1).max(2000),
			header: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("image"),
			path: text(260),
			caption: text(500).optional(),
			widthPercent: z.number().min(5).max(100).optional(),
		})
		.strict(),
	z.object({ type: z.literal("pageBreak") }).strict(),
]);

export const DocxSpecSchema = z
	.object({
		title: text(300).optional(),
		author: text(200).optional(),
		blocks: z.array(DocxBlockSchema).min(1).max(5000),
	})
	.strict();

export type DocxSpec = z.infer<typeof DocxSpecSchema>;

/** Table cells across the whole document. */
export const MAX_DOCX_CELLS = 20000;

const W_NS =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** A4 in twentieths of a point, one-inch margins. */
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1440;
const TEXT_W = PAGE_W - 2 * MARGIN;

/** Runs for one line of text: **bold** spans become bold runs, newlines become breaks. */
function runs(s: string, bold = false): string {
	const out: string[] = [];
	const lines = String(s).split("\n");
	lines.forEach((line, li) => {
		if (li > 0) out.push("<w:r><w:br/></w:r>");
		const parts = line.split(/\*\*(.+?)\*\*/g);
		parts.forEach((part, i) => {
			if (part === "") return;
			const b = bold || i % 2 === 1 ? "<w:rPr><w:b/></w:rPr>" : "";
			out.push(`<w:r>${b}<w:t xml:space="preserve">${esc(part)}</w:t></w:r>`);
		});
	});
	return out.join("");
}

function para(body: string, style?: string, extra = ""): string {
	const pPr =
		style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : "";
	return `<w:p>${pPr}${body}</w:p>`;
}

function cellText(v: string | number | boolean | null): string {
	return v === null ? "" : String(v);
}

function imageXml(rId: string, n: number, cx: number, cy: number, name: string): string {
	return (
		`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
		`<wp:docPr id="${n}" name="Picture ${n}" descr="${esc(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
		'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
		`<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="Picture ${n}"/><pic:cNvPicPr/></pic:nvPicPr>` +
		`<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
		`<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
		"</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
	);
}

const STYLES = `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:i/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

function lvl(fmt: "bullet" | "decimal", text: string, font?: string): string {
	const rPr = font
		? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>`
		: "";
	return `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>${rPr}</w:lvl>`;
}

/** Bullets are num 1; each numbered list gets its own num so it restarts at 1. */
function numbering(numberedLists: number): string {
	const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
	for (let i = 0; i < numberedLists; i++) {
		nums.push(
			`<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
		);
	}
	return (
		`${XML_HEAD}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
		`<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${lvl("bullet", "•", "Symbol")}</w:abstractNum>` +
		`<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${lvl("decimal", "%1.")}</w:abstractNum>` +
		`${nums.join("")}</w:numbering>`
	);
}

export interface DocxBuild {
	buffer: Buffer;
	blocks: number;
	images: number;
}

/** Build the .docx bytes for a spec. Images are read from inside cwd only. */
export function buildDocx(rawSpec: unknown, cwd: string): DocxBuild {
	const spec = parseSpec(DocxSpecSchema, rawSpec, "make_docx");
	const images = new ImageBox(cwd, "make_docx");
	const body: string[] = [];
	const rels: string[] = [];
	let numberedLists = 0;
	let cells = 0;

	if (spec.title) body.push(para(runs(spec.title), "Title"));
	for (const b of spec.blocks) {
		switch (b.type) {
			case "heading":
				body.push(para(runs(b.text), `Heading${b.level ?? 1}`));
				break;
			case "paragraph":
				body.push(para(runs(b.text)));
				break;
			case "bullets": {
				const numId = b.numbered ? 2 + numberedLists++ : 1;
				for (const item of b.items) {
					body.push(
						para(
							runs(item),
							"ListParagraph",
							`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`,
						),
					);
				}
				break;
			}
			case "table": {
				const cols = Math.max(...b.rows.map((r) => r.length), 1);
				cells += b.rows.length * cols;
				if (cells > MAX_DOCX_CELLS)
					throw new Error(`make_docx tables hold at most ${MAX_DOCX_CELLS} cells`);
				const w = Math.floor(TEXT_W / cols);
				const header = b.header !== false;
				const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join("");
				const rows = b.rows.map((row, ri) => {
					const bold = header && ri === 0;
					const trPr = bold ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
					const tcs = Array.from({ length: cols }, (_, ci) => {
						const v = cellText(row[ci] ?? null);
						return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${para(runs(v, bold))}</w:tc>`;
					});
					return `<w:tr>${trPr}${tcs.join("")}</w:tr>`;
				});
				body.push(
					`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${w * cols}" w:type="dxa"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join("")}</w:tbl>`,
				);
				// Word needs a paragraph between two adjacent tables, and it spaces the table from what follows.
				body.push(para(""));
				break;
			}
			case "image": {
				const idx = images.add(b.path);
				const img = images.list[idx];
				const rId = `rIdImg${idx + 1}`;
				// Natural size at 96 dpi, never wider than the text column (or the requested share of it).
				const maxW = (TEXT_W / 1440) * EMU_IN * ((b.widthPercent ?? 100) / 100);
				const naturalW = (img.width / 96) * EMU_IN;
				const { cx, cy } = fit(img.width, img.height, Math.min(maxW, naturalW), 8 * EMU_IN);
				body.push(
					para(
						imageXml(rId, body.length + 1, cx, cy, b.caption ?? b.path),
						undefined,
						'<w:jc w:val="center"/>',
					),
				);
				if (b.caption) body.push(para(runs(b.caption), "Caption", '<w:jc w:val="center"/>'));
				break;
			}
			case "pageBreak":
				body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
				break;
		}
	}
	images.list.forEach((img, i) => {
		rels.push(
			`<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${img.ext}"/>`,
		);
	});

	const sect = `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
	const document = `${XML_HEAD}<w:document ${W_NS}><w:body>${body.join("")}${sect}</w:body></w:document>`;

	const entries: ZipEntry[] = [
		{
			name: "[Content_Types].xml",
			data:
				`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
				'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
				'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
				'<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
				'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
				'<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
				"</Types>",
		},
		{
			name: "_rels/.rels",
			data:
				`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
				'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
				'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
				"</Relationships>",
		},
		{ name: "docProps/core.xml", data: coreXml(spec.title, spec.author) },
		{ name: "docProps/app.xml", data: appXml() },
		{ name: "word/document.xml", data: document },
		{ name: "word/styles.xml", data: STYLES },
		{ name: "word/numbering.xml", data: numbering(numberedLists) },
		{
			name: "word/_rels/document.xml.rels",
			data:
				`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				'<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
				'<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
				`${rels.join("")}</Relationships>`,
		},
		...images.list.map((img, i) => ({
			name: `word/media/image${i + 1}.${img.ext}`,
			data: img.data,
		})),
	];
	return { buffer: writeZip(entries), blocks: spec.blocks.length, images: images.list.length };
}
