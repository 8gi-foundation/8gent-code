/**
 * 8gent Code - make_docx, make_xlsx and make_pptx (#4274).
 *
 * One entry for the three tools: build the bytes from the spec, write them to
 * the path the caller already confined to the working directory, and return
 * what was written, counted from the file read back rather than from the spec.
 */

import * as fs from "node:fs";
import { buildDocx } from "./docx";
import { buildPptx } from "./pptx";
import { officeText } from "./read";
import { buildXlsx } from "./xlsx";

export type OfficeKind = "docx" | "xlsx" | "pptx";

/** Largest file any of the three tools will write. */
export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

export const DEFAULT_OUT: Record<OfficeKind, string> = {
	docx: "document.docx",
	xlsx: "workbook.xlsx",
	pptx: "deck.pptx",
};

export interface MakeOfficeResult {
	path: string;
	kind: "document";
	format: OfficeKind;
	bytes: number;
	/** docx: blocks; xlsx: sheets and cells; pptx: slides and notes. */
	blocks?: number;
	sheets?: number;
	cells?: number;
	slides?: number;
	notes?: number;
	images?: number;
	/** Characters of text read back from the written file. */
	textChars: number;
}

/**
 * Build and write. `out` must already be an absolute path inside the working directory
 * (resolveOfficeOut in packages/eight/tools.ts); `cwd` bounds the image reads.
 */
export function makeOffice(
	kind: OfficeKind,
	spec: unknown,
	out: string,
	cwd: string,
): MakeOfficeResult {
	let buffer: Buffer;
	let counts: Partial<MakeOfficeResult>;
	if (kind === "docx") {
		const b = buildDocx(spec, cwd);
		buffer = b.buffer;
		counts = { blocks: b.blocks, images: b.images };
	} else if (kind === "xlsx") {
		const b = buildXlsx(spec);
		buffer = b.buffer;
		counts = { sheets: b.sheets, cells: b.cells };
	} else {
		const b = buildPptx(spec, cwd);
		buffer = b.buffer;
		counts = { slides: b.slides, notes: b.notes, images: b.images };
	}
	if (buffer.length > MAX_OUTPUT_BYTES) {
		throw new Error(
			`the ${kind} would be ${buffer.length} bytes; the limit is ${MAX_OUTPUT_BYTES}`,
		);
	}
	// Read our own bytes back before writing: a part the reader cannot walk never reaches disk.
	const text = officeText(buffer, `.${kind}`);
	fs.writeFileSync(out, buffer);
	return {
		path: out,
		kind: "document",
		format: kind,
		bytes: buffer.length,
		...counts,
		textChars: text.length,
	};
}
