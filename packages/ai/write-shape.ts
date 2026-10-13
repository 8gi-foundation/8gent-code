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
 * A separator is any line that is exactly `---`, which is what a person means
 * by "separated by ---". It deliberately does not follow CommonMark's setext
 * rule (deck/parse.ts does, for rendering): under that rule "Body text\n---"
 * is a heading, and the 6-slide file from the pilot would count as 1.
 * Leading YAML front matter and `---` inside fenced code are not separators.
 *
 * Code and config files get nothing: the line is only for text deliverables.
 */

import { extname } from "node:path";

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const SEPARATOR = /^---[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A top-level YAML line: `key:` or a `- ` list item. Indented lines are values. */
const YAML_TOP = /^([\w-]+\s*:|-\s)/;

/** Drop leading YAML front matter (a Marp header): it is not a section. */
function stripFrontMatter(lines: string[]): string[] {
	if (lines.length === 0 || !SEPARATOR.test(lines[0])) return lines;
	const end = lines.findIndex((l, i) => i > 0 && SEPARATOR.test(l));
	if (end < 0) return lines;
	const header = lines.slice(1, end);
	const top = header.filter((l) => l.trim() !== "" && !/^\s/.test(l));
	// A leading "---" before prose is a section separator, not front matter.
	if (top.length === 0 || !top.every((l) => YAML_TOP.test(l))) return lines;
	return lines.slice(end + 1);
}

/**
 * One line describing what was written, or "" when the file is not a text
 * deliverable or is empty. Example:
 * "Shape: 6 non-empty lines; 6 sections separated by ---. ..."
 * Both counts exclude front matter.
 */
export function writeShapeLine(filePath: string, content: string): string {
	if (!TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) return "";
	const body = stripFrontMatter(content.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n"));
	const nonEmpty = body.filter((l) => l.trim() !== "").length;
	if (nonEmpty === 0) return "";
	const sections: string[][] = [[]];
	let fence: string | null = null;
	let separators = 0;
	for (const l of body) {
		const f = FENCE.exec(l)?.[1];
		if (fence) {
			if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
		} else if (f) {
			fence = f;
		} else if (SEPARATOR.test(l)) {
			separators++;
			sections.push([]);
			continue;
		}
		sections[sections.length - 1].push(l);
	}
	let parts = "";
	if (separators > 0) {
		const count = sections.filter((s) => s.some((l) => l.trim() !== "")).length;
		parts = `; ${count} section${count === 1 ? "" : "s"} separated by ---`;
	}
	return `Shape: ${nonEmpty} non-empty line${nonEmpty === 1 ? "" : "s"}${parts}. If the request named a count, check it matches before moving on.`;
}
