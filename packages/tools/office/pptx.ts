/**
 * 8gent Code - make_pptx core (#4274).
 *
 * The spec is render_video_deck's slide shape ({ kicker, title, text, bullets,
 * image, narration }) plus `notes`, so one spec can become a film or a deck:
 * narration becomes the speaker notes when a slide has no notes of its own, and
 * the film-only fields (seconds, voice, size) are accepted and ignored. Slides are
 * 16:9 in the film's palette (warm near-black, cream ink, amber kicker), drawn as
 * plain text boxes and pictures on a blank layout. Deterministic, no network,
 * never a macro part.
 */

import { z } from "zod";
import { EMU_IN, ImageBox, XML_HEAD, appXml, coreXml, esc, fit, parseSpec } from "./common";
import { type ZipEntry, writeZip } from "./zip";

const text = (max: number) => z.string().max(max);

export const PptxSlideSchema = z
	.object({
		kicker: text(80).optional(),
		title: text(300).optional(),
		text: text(4000).optional(),
		bullets: z.array(text(500)).max(20).optional(),
		/** Raster image (png/jpg) inside the working directory. Never a URL. */
		image: text(260).optional(),
		notes: text(20000).optional(),
		// render_video_deck fields: narration doubles as notes; the rest only matter to a film.
		narration: text(20000).optional(),
		seconds: z.number().optional(),
		voice: text(40).optional(),
	})
	.strict()
	.refine((s) => s.title || s.text || s.bullets?.length || s.image, {
		message: "a slide needs at least one of title, text, bullets or image",
	});

export const PptxSpecSchema = z
	.object({
		title: text(300).optional(),
		author: text(200).optional(),
		size: z.enum(["1280x720", "1920x1080"]).optional(),
		voice: text(40).optional(),
		slides: z.array(PptxSlideSchema).min(1).max(300),
	})
	.strict();

export type PptxSpec = z.infer<typeof PptxSpecSchema>;
type Slide = z.infer<typeof PptxSlideSchema>;

const NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** 16:9 at 13.333 x 7.5 inches. */
const W = 12192000;
const H = 6858000;
const MX = Math.round(0.7 * EMU_IN);
const BODY_Y = Math.round(2.3 * EMU_IN);
const BODY_H = Math.round(4.6 * EMU_IN);

/** The film palette (video-deck COLORS), no hue in 270-350. */
const C = { bg: "0B0A09", ink: "F3ECE2", muted: "B7A993", amber: "E3A53C" };
const SERIF = "Georgia";
const SANS = "Avenir";

const SP_TREE_HEAD =
	'<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

interface Run {
	text: string;
	size: number;
	color: string;
	font: string;
	caps?: boolean;
	bullet?: boolean;
}

function paragraph(r: Run, align = "l"): string {
	const pPr = r.bullet
		? `<a:pPr marL="342900" indent="-342900" algn="${align}"><a:spcBef><a:spcPts val="600"/></a:spcBef><a:buClr><a:srgbClr val="${C.amber}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>`
		: `<a:pPr algn="${align}"><a:buNone/></a:pPr>`;
	const caps = r.caps ? ' cap="all" spc="300"' : "";
	const rPr = `<a:rPr lang="en-GB" sz="${r.size * 100}"${caps} dirty="0"><a:solidFill><a:srgbClr val="${r.color}"/></a:solidFill><a:latin typeface="${r.font}"/></a:rPr>`;
	const t = r.text === "" ? "" : `<a:r>${rPr}<a:t>${esc(r.text)}</a:t></a:r>`;
	return `<a:p>${pPr}${t}<a:endParaRPr lang="en-GB" sz="${r.size * 100}" dirty="0"/></a:p>`;
}

function textBox(
	id: number,
	name: string,
	x: number,
	y: number,
	cx: number,
	cy: number,
	paras: string[],
	anchor = "t",
): string {
	return (
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
		`<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
		`<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras.join("")}</p:txBody></p:sp>`
	);
}

function picture(
	id: number,
	rId: string,
	x: number,
	y: number,
	cx: number,
	cy: number,
	descr: string,
): string {
	return (
		`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
		`<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
		`<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
	);
}

function slideXml(s: Slide, img: { width: number; height: number } | null): string {
	const shapes: string[] = [];
	let id = 2;
	const hasBody = Boolean(s.text || s.bullets?.length);
	const titleOnly = !hasBody && !img && !s.kicker;
	if (titleOnly && s.title) {
		shapes.push(
			textBox(
				id++,
				"Title",
				MX,
				Math.round(H * 0.3),
				W - 2 * MX,
				Math.round(H * 0.4),
				[paragraph({ text: s.title, size: 44, color: C.ink, font: SERIF }, "ctr")],
				"ctr",
			),
		);
	} else {
		if (s.kicker) {
			shapes.push(
				textBox(
					id++,
					"Kicker",
					MX,
					Math.round(0.5 * EMU_IN),
					W - 2 * MX,
					Math.round(0.4 * EMU_IN),
					[paragraph({ text: s.kicker, size: 14, color: C.amber, font: SANS, caps: true })],
				),
			);
		}
		if (s.title) {
			shapes.push(
				textBox(
					id++,
					"Title",
					MX,
					Math.round(0.95 * EMU_IN),
					W - 2 * MX,
					Math.round(1.2 * EMU_IN),
					[paragraph({ text: s.title, size: 36, color: C.ink, font: SERIF })],
					"b",
				),
			);
		}
		const bodyW = img && hasBody ? Math.round(6.6 * EMU_IN) : W - 2 * MX;
		if (hasBody) {
			const paras: string[] = [];
			for (const line of (s.text ?? "").split("\n").filter((l) => l.trim() !== "")) {
				paras.push(paragraph({ text: line, size: 20, color: C.muted, font: SANS }));
			}
			for (const b of s.bullets ?? [])
				paras.push(paragraph({ text: b, size: 22, color: C.ink, font: SANS, bullet: true }));
			shapes.push(textBox(id++, "Body", MX, BODY_Y, bodyW, BODY_H, paras));
		}
		if (img) {
			const areaX = hasBody ? MX + bodyW + Math.round(0.4 * EMU_IN) : MX;
			const areaW = W - MX - areaX;
			const { cx, cy } = fit(img.width, img.height, areaW, BODY_H);
			const x = areaX + Math.round((areaW - cx) / 2);
			const y = BODY_Y + Math.round((BODY_H - cy) / 2);
			shapes.push(picture(id++, "rId2", x, y, cx, cy, s.image ?? ""));
		}
	}
	return (
		`${XML_HEAD}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${C.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
		`<p:spTree>${SP_TREE_HEAD}${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
	);
}

function notesXml(notes: string): string {
	const paras = notes
		.split("\n")
		.map(
			(l) =>
				`<a:p>${l ? `<a:r><a:rPr lang="en-GB" dirty="0"/><a:t>${esc(l)}</a:t></a:r>` : ""}</a:p>`,
		)
		.join("");
	return (
		`${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree>${SP_TREE_HEAD}` +
		'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
		`<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>` +
		"</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
	);
}

const CLR_MAP =
	'<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

const SLIDE_MASTER =
	`${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_HEAD}</p:spTree></p:cSld>${CLR_MAP}` +
	'<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
	'<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';

const SLIDE_LAYOUT = `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${SP_TREE_HEAD}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const NOTES_MASTER =
	`${XML_HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_HEAD}` +
	'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>' +
	'<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody></p:sp>' +
	`</p:spTree></p:cSld>${CLR_MAP}</p:notesMaster>`;

function theme(name: string): string {
	const scheme = (tag: string, latin: string) =>
		`<a:${tag}><a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`;
	const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
	const line = (w: number) =>
		`<a:ln w="${w}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
	return (
		`${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>` +
		'<a:clrScheme name="8gent"><a:dk1><a:srgbClr val="0B0A09"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="15120E"/></a:dk2><a:lt2><a:srgbClr val="F3ECE2"/></a:lt2>' +
		'<a:accent1><a:srgbClr val="E3A53C"/></a:accent1><a:accent2><a:srgbClr val="B7A993"/></a:accent2><a:accent3><a:srgbClr val="5B8A72"/></a:accent3><a:accent4><a:srgbClr val="3E6E8E"/></a:accent4><a:accent5><a:srgbClr val="C4642D"/></a:accent5><a:accent6><a:srgbClr val="8C8C8C"/></a:accent6>' +
		'<a:hlink><a:srgbClr val="3E6E8E"/></a:hlink><a:folHlink><a:srgbClr val="5B8A72"/></a:folHlink></a:clrScheme>' +
		`<a:fontScheme name="8gent">${scheme("majorFont", SERIF)}${scheme("minorFont", SANS)}</a:fontScheme>` +
		`<a:fmtScheme name="8gent"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
		"<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
		`<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
	);
}

function rels(list: Array<[id: string, type: string, target: string]>): string {
	return (
		`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
		list
			.map(
				([id, type, target]) =>
					`<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
			)
			.join("") +
		"</Relationships>"
	);
}

export interface PptxBuild {
	buffer: Buffer;
	slides: number;
	images: number;
	notes: number;
}

/** Build the .pptx bytes for a spec. Images are read from inside cwd only. */
export function buildPptx(rawSpec: unknown, cwd: string): PptxBuild {
	const spec = parseSpec(PptxSpecSchema, rawSpec, "make_pptx");
	const images = new ImageBox(cwd, "make_pptx");
	const n = spec.slides.length;
	const slideParts: ZipEntry[] = [];
	let notesCount = 0;

	spec.slides.forEach((s, i) => {
		const k = i + 1;
		const idx = s.image ? images.add(s.image) : -1;
		const img = idx >= 0 ? images.list[idx] : null;
		const slideRels: Array<[string, string, string]> = [
			["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
		];
		if (img) slideRels.push(["rId2", "image", `../media/image${idx + 1}.${img.ext}`]);
		const notes = s.notes ?? s.narration;
		if (notes) {
			notesCount++;
			slideRels.push(["rId3", "notesSlide", `../notesSlides/notesSlide${k}.xml`]);
			slideParts.push(
				{ name: `ppt/notesSlides/notesSlide${k}.xml`, data: notesXml(notes) },
				{
					name: `ppt/notesSlides/_rels/notesSlide${k}.xml.rels`,
					data: rels([
						["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"],
						["rId2", "slide", `../slides/slide${k}.xml`],
					]),
				},
			);
		}
		slideParts.push(
			{ name: `ppt/slides/slide${k}.xml`, data: slideXml(s, img) },
			{ name: `ppt/slides/_rels/slide${k}.xml.rels`, data: rels(slideRels) },
		);
	});

	const sldIds = spec.slides
		.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`)
		.join("");
	const presentation =
		`${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1">` +
		'<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst>' +
		'<p:notesMasterIdLst><p:notesMasterId r:id="rIdNM"/></p:notesMasterIdLst>' +
		`<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
	const presRels = rels([
		["rIdM", "slideMaster", "slideMasters/slideMaster1.xml"],
		["rIdNM", "notesMaster", "notesMasters/notesMaster1.xml"],
		["rIdT", "theme", "theme/theme1.xml"],
		["rIdP", "presProps", "presProps.xml"],
		["rIdV", "viewProps", "viewProps.xml"],
		["rIdTS", "tableStyles", "tableStyles.xml"],
		...spec.slides.map(
			(_, i) => [`rIdS${i + 1}`, "slide", `slides/slide${i + 1}.xml`] as [string, string, string],
		),
	]);
	const ct = (part: string, type: string) =>
		`<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`;
	const types =
		`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		'<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
		ct("ppt/presentation.xml", "presentation.main") +
		ct("ppt/slideMasters/slideMaster1.xml", "slideMaster") +
		ct("ppt/slideLayouts/slideLayout1.xml", "slideLayout") +
		ct("ppt/notesMasters/notesMaster1.xml", "notesMaster") +
		ct("ppt/presProps.xml", "presProps") +
		ct("ppt/viewProps.xml", "viewProps") +
		ct("ppt/tableStyles.xml", "tableStyles") +
		spec.slides.map((_, i) => ct(`ppt/slides/slide${i + 1}.xml`, "slide")).join("") +
		spec.slides
			.map((s, i) =>
				(s.notes ?? s.narration) ? ct(`ppt/notesSlides/notesSlide${i + 1}.xml`, "notesSlide") : "",
			)
			.join("") +
		'<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
		'<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
		'<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
		"</Types>";

	const buffer = writeZip([
		{ name: "[Content_Types].xml", data: types },
		{
			name: "_rels/.rels",
			data:
				`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
				'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
				`<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
				"</Relationships>",
		},
		{ name: "docProps/core.xml", data: coreXml(spec.title, spec.author) },
		{ name: "docProps/app.xml", data: appXml() },
		{ name: "ppt/presentation.xml", data: presentation },
		{ name: "ppt/_rels/presentation.xml.rels", data: presRels },
		{ name: "ppt/presProps.xml", data: `${XML_HEAD}<p:presentationPr ${NS}/>` },
		{
			name: "ppt/viewProps.xml",
			data: `${XML_HEAD}<p:viewPr ${NS}><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
		},
		{
			name: "ppt/tableStyles.xml",
			data: `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
		},
		{ name: "ppt/slideMasters/slideMaster1.xml", data: SLIDE_MASTER },
		{
			name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
			data: rels([
				["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
				["rId2", "theme", "../theme/theme1.xml"],
			]),
		},
		{ name: "ppt/slideLayouts/slideLayout1.xml", data: SLIDE_LAYOUT },
		{
			name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
			data: rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
		},
		{ name: "ppt/notesMasters/notesMaster1.xml", data: NOTES_MASTER },
		{
			name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
			data: rels([["rId1", "theme", "../theme/theme2.xml"]]),
		},
		{ name: "ppt/theme/theme1.xml", data: theme("8gent") },
		{ name: "ppt/theme/theme2.xml", data: theme("8gent notes") },
		...slideParts,
		...images.list.map((img, i) => ({
			name: `ppt/media/image${i + 1}.${img.ext}`,
			data: img.data,
		})),
	]);
	return { buffer, slides: n, images: images.list.length, notes: notesCount };
}
