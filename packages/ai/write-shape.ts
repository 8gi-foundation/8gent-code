/**
 * 8gent Code - the shape of a just-written text file (#3580).
 *
 * Small local models lose count. In the media-brief-video pilot the model
 * was asked for "5 slides separated by ---" and "exactly one line per
 * slide", wrote 6 of each, then marked its plan step "5 slides" done. The
 * write result only said "File written", so nothing put the real count in
 * front of it. This line does: for prose files it reports how many non-empty
 * lines and how many ----separated sections were written, so a count the
 * user asked for can be checked against what is on disk.
 *
 * Code and config files get nothing: the line is only for text deliverables.
 */

import { extname } from "node:path";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const SEPARATOR = /^---[ \t]*$/;

/** Leading YAML front matter (a Marp header), which is not a section. */
function stripFrontMatter(lines: string[]): string[] {
	if (lines.length === 0 || !SEPARATOR.test(lines[0])) return lines;
	const end = lines.findIndex((l, i) => i > 0 && SEPARATOR.test(l));
	if (end < 0) return lines;
	const header = lines.slice(1, end);
	// Only a header of key: value lines is front matter; a leading "---" before
	// prose is a section separator.
	if (header.length === 0 || !header.every((l) => l.trim() === "" || /^[\w-]+\s*:/.test(l)))
		return lines;
	return lines.slice(end + 1);
}

/**
 * One line describing what was written, or "" when the file is not a text
 * deliverable. Example: "Shape: 6 non-empty lines; 6 sections separated by ---."
 */
export function writeShapeLine(filePath: string, content: string): string {
	if (!TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) return "";
	const lines = content.replace(/\r\n?/g, "\n").split("\n");
	const nonEmpty = lines.filter((l) => l.trim() !== "").length;
	const body = stripFrontMatter(lines);
	let parts = "";
	if (body.some((l) => SEPARATOR.test(l))) {
		const sections: string[][] = [[]];
		for (const l of body) {
			if (SEPARATOR.test(l)) sections.push([]);
			else sections[sections.length - 1].push(l);
		}
		const count = sections.filter((s) => s.some((l) => l.trim() !== "")).length;
		parts = `; ${count} section${count === 1 ? "" : "s"} separated by ---`;
	}
	return `Shape: ${nonEmpty} non-empty line${nonEmpty === 1 ? "" : "s"}${parts}. If the request named a count, check it matches before moving on.`;
}
