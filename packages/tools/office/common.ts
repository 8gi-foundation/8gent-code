/**
 * 8gent Code - shared pieces of make_docx, make_xlsx and make_pptx (#4274).
 */

import type { z } from "zod";
import { imageDimensions, readInside } from "../video-deck";

/** Largest spec, as JSON text, any office tool accepts. */
export const MAX_SPEC_CHARS = 4_000_000;
/** Images per document and their combined bytes (each image is also held to video-deck's 10 MB). */
export const MAX_IMAGES = 40;
export const MAX_IMAGE_TOTAL_BYTES = 60 * 1024 * 1024;

const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** Text safe inside an XML element or attribute: escaped, and control characters dropped. */
export function esc(s: string): string {
	return String(s)
		.replace(INVALID_XML, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Validate a spec against its schema. A model sometimes sends the spec as a JSON string;
 * that is parsed first. The size check runs before any parsing work on the content.
 */
export function parseSpec<T>(schema: z.ZodType<T>, spec: unknown, tool: string): T {
	let value = spec;
	const size = typeof spec === "string" ? spec.length : (JSON.stringify(spec ?? null) ?? "").length;
	if (size > MAX_SPEC_CHARS) {
		throw new Error(`${tool} spec is ${size} characters; the limit is ${MAX_SPEC_CHARS}`);
	}
	if (typeof spec === "string") {
		try {
			value = JSON.parse(spec);
		} catch {
			throw new Error(`${tool} spec is a string that is not valid JSON`);
		}
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.slice(0, 5)
			.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`)
			.join("; ");
		throw new Error(`${tool} spec is invalid: ${issues}`);
	}
	return parsed.data;
}

export interface LoadedImage {
	data: Buffer;
	ext: "png" | "jpeg";
	width: number;
	height: number;
}

/** Reads every image a document names, inside the working directory, once each, within the limits. */
export class ImageBox {
	private total = 0;
	readonly list: LoadedImage[] = [];
	private byName = new Map<string, number>();

	constructor(
		private cwd: string,
		private tool: string,
	) {}

	/** Index of the image in `list` (1-based media number is index + 1). */
	add(named: string): number {
		const known = this.byName.get(named);
		if (known !== undefined) return known;
		if (this.list.length >= MAX_IMAGES) {
			throw new Error(`${this.tool} accepts at most ${MAX_IMAGES} images`);
		}
		const data = readInside(named, this.cwd);
		this.total += data.length;
		if (this.total > MAX_IMAGE_TOTAL_BYTES) {
			throw new Error(`${this.tool} images total over ${MAX_IMAGE_TOTAL_BYTES} bytes`);
		}
		const dim = imageDimensions(data) as { width: number; height: number };
		const ext = data[0] === 0x89 ? "png" : "jpeg";
		this.list.push({ data, ext, width: dim.width, height: dim.height });
		this.byName.set(named, this.list.length - 1);
		return this.list.length - 1;
	}
}

/** Fit (w, h) inside (maxW, maxH), keeping the aspect ratio. Integers, for EMU. */
export function fit(w: number, h: number, maxW: number, maxH: number): { cx: number; cy: number } {
	const k = Math.min(maxW / w, maxH / h);
	return { cx: Math.round(w * k), cy: Math.round(h * k) };
}

/** EMU per inch, the OOXML drawing unit. */
export const EMU_IN = 914400;

/** Dublin Core properties with no timestamps, so the bytes stay the same run to run. */
export function coreXml(title?: string, author?: string): string {
	return (
		`${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
		(title ? `<dc:title>${esc(title)}</dc:title>` : "") +
		`<dc:creator>${esc(author ?? "8gent Code")}</dc:creator>` +
		"</cp:coreProperties>"
	);
}

export function appXml(): string {
	return `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>8gent Code</Application></Properties>`;
}
