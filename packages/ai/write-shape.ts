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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

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

/** Front matter dropped, then the lines of each ----separated section (fences respected). */
function splitSections(content: string): {
	body: string[];
	sections: string[][];
	separators: number;
} {
	const body = stripFrontMatter(content.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n"));
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
	return { body, sections, separators };
}

/**
 * One line describing what was written, or "" when the file is not a text
 * deliverable or is empty. Example:
 * "Shape: 6 non-empty lines; 6 sections separated by ---. ..."
 * Both counts exclude front matter.
 */
export function writeShapeLine(filePath: string, content: string): string {
	if (!TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) return "";
	const { body, sections, separators } = splitSections(content);
	const nonEmpty = body.filter((l) => l.trim() !== "").length;
	if (nonEmpty === 0) return "";
	let parts = "";
	if (separators > 0) {
		const count = sections.filter((s) => s.some((l) => l.trim() !== "")).length;
		parts = `; ${count} section${count === 1 ? "" : "s"} separated by ---`;
	}
	const shape = `Shape: ${nonEmpty} non-empty line${nonEmpty === 1 ? "" : "s"}${parts}. If the request named a count, check it matches before moving on.`;
	const coverage = isAbsolute(filePath) ? narrationCoverageAfterWrite(filePath) : "";
	return coverage ? `${shape}\n${coverage}` : shape;
}

/*
 * Narration coverage (#4154). In pilot run 2026-10-13_034421/media-brief-video
 * brief point 4 read "How to help. We need volunteers to check and repair
 * returned tools." and narration.txt said "Help us by checking and repairing
 * returned tools". The point was paraphrased and its key noun, volunteers,
 * dropped. Nothing compared the narration to the brief, so the video rendered
 * without it.
 *
 * This is a property of the output: the narration as written on disk is
 * checked against each point of the brief (the numbered list in brief.md
 * beside or above it; the slides when there is no brief). A point is covered
 * when the narration carries every key term the point names. A failure names
 * the point and the missing term, never a count. It is checked when the
 * narration or slides are written, refused before a render (ffmpeg, or a
 * script that calls it), and reported after any command that rendered a video
 * beside a narration that still lacks a point. EIGHT_NARRATION_CHECK=0 turns
 * all three off.
 */

const SLIDES_NAMES = ["slides.md", "slides.markdown"];
const NARRATION_NAMES = [
	"narration.txt",
	"narration.md",
	"voiceover.txt",
	"voice-over.txt",
	"script.txt",
	"script.md",
];
const BRIEF_NAMES = ["brief.md", "BRIEF.md", "brief.txt"];
const STOPWORDS = new Set(
	(
		"about above after again also anyone been before being both does doing down during each even every from have " +
		"having here into just like make made more most much must need needs only other ours over same should some such " +
		"than that their them then there these they this those through under until very want were what when where which " +
		"while will with would your yours itself"
	).split(" "),
);
const NUMBER_WORDS = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
	"eleven",
	"twelve",
];

/** Same normalisation on both sides, so "volunteers" matches "volunteer" and "repairing" matches "repair". */
function stem(word: string): string {
	let w = word.toLowerCase().replace(/['’]s$/, "");
	if (/ies$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`;
	else if (/[^s]s$/.test(w) && w.length > 3) w = w.slice(0, -1);
	if (/ing$/.test(w) && w.length >= 6) w = w.slice(0, -3);
	else if (/ed$/.test(w) && w.length >= 5) w = w.slice(0, -2);
	return w;
}

function clean(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, " ").replace(/\]\([^)]*\)/g, "] ");
}

/**
 * The key terms a point names: the words a listener must hear for the point to
 * be said. A word is a candidate at four letters or more, not a stopword, not
 * an -ing/-ed/-ly form. A lowercase word directly followed by another word is
 * a modifier ("free membership card" keys on "card"); a capitalised one is a
 * name and stays ("Wednesday evenings" keys on both). First spelling is kept
 * for the message.
 */
function keyTerms(text: string): Map<string, string> {
	const terms = new Map<string, string>();
	const tokens = [...clean(text).matchAll(/[\p{L}\d]+|[^\p{L}\d]+/gu)].map((m) => m[0]);
	for (let i = 0; i < tokens.length; i++) {
		const w = tokens[i];
		if (!/^\p{L}{4,}$/u.test(w) || STOPWORDS.has(w.toLowerCase())) continue;
		if (/(ing|ed|ly)$/i.test(w)) continue;
		const gap = tokens[i + 1];
		const next = tokens[i + 2];
		const modifies =
			gap !== undefined &&
			/^[ \t-]+$/.test(gap) &&
			next !== undefined &&
			/^\p{L}{4,}$/u.test(next) &&
			!STOPWORDS.has(next.toLowerCase()) &&
			!/(ing|ed|ly)$/i.test(next);
		if (modifies && !/^\p{Lu}/u.test(w)) continue;
		const s = stem(w);
		if (!terms.has(s)) terms.set(s, w.toLowerCase());
	}
	return terms;
}

/** A point of the brief: its label ("How to help") and the text that says it. */
export interface BriefPoint {
	label: string;
	text: string;
}

/**
 * The numbered points of a brief, in order. "4. How to help. We need ..."
 * gives label "How to help" and text "We need ...": a short leading sentence
 * is the label, not the point. Continuation lines belong to their point.
 */
export function briefPoints(brief: string): BriefPoint[] {
	const points: string[] = [];
	let open = false;
	for (const line of brief.replace(/\r\n?/g, "\n").split("\n")) {
		const m = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
		if (m) {
			points.push(m[1].trim());
			open = true;
		} else if (open && line.trim() !== "" && !/^\s{0,3}(#|[-*+]\s)/.test(line)) {
			points[points.length - 1] += ` ${line.trim()}`;
		} else {
			open = false;
		}
	}
	return points.map((p) => {
		const label = /^([^.!?:]{1,40})[.:]\s+(\S.*)$/.exec(p);
		if (label && label[1].trim().split(/\s+/).length <= 5)
			return { label: label[1].trim(), text: label[2] };
		return { label: p.split(/\s+/).slice(0, 5).join(" "), text: p };
	});
}

/** The slides as points, when there is no brief: heading as label, body as text (headings are labels). */
export function slidePoints(slidesMd: string): BriefPoint[] {
	return splitSections(slidesMd)
		.sections.filter((s) => s.some((l) => l.trim() !== ""))
		.map((lines) => {
			const head = lines.find((l) => l.trim() !== "") ?? "";
			const body = lines.filter((l) => l.trim() !== "" && !/^\s{0,3}#/.test(l));
			return {
				label: head.replace(/^\s*#+\s*/, "").trim(),
				text: (body.length > 0 ? body : [head]).join("\n"),
			};
		});
}

/** One point the narration does not carry, and the key terms it never says. */
export interface NarrationGap {
	label: string;
	missing: string[];
}

/** Every point whose key terms the narration does not all carry. Empty when it covers them all. */
export function narrationGaps(points: BriefPoint[], narration: string): NarrationGap[] {
	const spoken = new Set<string>();
	for (const w of clean(narration)
		.split(/[^\p{L}\d]+/u)
		.filter(Boolean)) {
		spoken.add(
			stem(/^\d+$/.test(w) && Number(w) < NUMBER_WORDS.length ? NUMBER_WORDS[Number(w)] : w),
		);
	}
	const gaps: NarrationGap[] = [];
	for (const p of points) {
		const missing = [...keyTerms(p.text)].filter(([s]) => !spoken.has(s)).map(([, w]) => w);
		if (missing.length > 0) gaps.push({ label: p.label, missing });
	}
	return gaps;
}

/** "the narration has no segment for: How to help (missing: volunteers)". Named, never counted. */
export function describeGaps(gaps: NarrationGap[]): string {
	return `the narration has no segment for: ${gaps.map((g) => `${g.label} (missing: ${g.missing.join(", ")})`).join("; ")}`;
}

const KEEP_TERMS =
	'Give each point its own segment and keep the point\'s named terms word for word (a call to action names what is needed, for example "we need volunteers to ...")';

function checkOff(): boolean {
	return process.env.EIGHT_NARRATION_CHECK === "0";
}

function firstIn(dir: string, names: string[]): string {
	for (const name of names) {
		const p = join(dir, name);
		try {
			if (existsSync(p)) return p;
		} catch {
			// unreadable: not there
		}
	}
	return "";
}

interface Coverage {
	narration: string;
	source: string;
	gaps: NarrationGap[];
}

/**
 * The narration in `dir` checked against its brief (in `dir` or the folder
 * above, where a brief usually sits beside its video/ folder), or against the
 * slides in `dir` when there is no brief. Null when there is nothing to check.
 */
function coverageIn(dir: string): Coverage | null {
	const narration = firstIn(dir, NARRATION_NAMES);
	if (!narration) return null;
	try {
		const brief = firstIn(dir, BRIEF_NAMES) || firstIn(dirname(dir), BRIEF_NAMES);
		const points = brief ? briefPoints(readFileSync(brief, "utf8")) : [];
		const slides = firstIn(dir, SLIDES_NAMES);
		if (points.length > 0) {
			return {
				narration,
				source: brief,
				gaps: narrationGaps(points, readFileSync(narration, "utf8")),
			};
		}
		if (slides) {
			const slidePts = slidePoints(readFileSync(slides, "utf8"));
			return {
				narration,
				source: slides,
				gaps: narrationGaps(slidePts, readFileSync(narration, "utf8")),
			};
		}
	} catch {
		// unreadable: not ours to judge
	}
	return null;
}

/** After a narration or slides file is written: name every point the narration does not carry. */
function narrationCoverageAfterWrite(filePath: string): string {
	const name = basename(filePath);
	if (checkOff() || !(SLIDES_NAMES.includes(name) || NARRATION_NAMES.includes(name))) return "";
	const found = coverageIn(dirname(filePath));
	if (!found || found.gaps.length === 0) return "";
	return `Coverage against ${basename(found.source)}: ${describeGaps(found.gaps)}. ${KEEP_TERMS}, or the render will be refused.`;
}

/** Whether `command` renders (runs ffmpeg, directly or through a script it names) and the folders it reaches. */
function renderTargets(command: string, cwd: string): { renders: boolean; dirs: Set<string> } {
	const tokens = command
		.split(/[\s;&|()<>]+/)
		.map((t) => t.replace(/^["']|["']$/g, ""))
		.filter(Boolean);
	let renders = /\bffmpeg\b/.test(command);
	const dirs = new Set<string>([cwd]);
	for (const t of tokens) {
		if (!t.includes("/") && !/\.\w{1,5}$/.test(t)) continue;
		const abs = resolve(cwd, t);
		dirs.add(dirname(abs));
		if (/\.(sh|bash|zsh)$/.test(t)) {
			try {
				const script = readFileSync(abs, "utf8");
				if (/\bffmpeg\b/.test(script)) {
					renders = true;
					// A script that does `cd video` renders there.
					for (const m of script.matchAll(/^\s*cd\s+["']?([^\s"';&]+)/gm))
						dirs.add(resolve(cwd, m[1]));
				}
			} catch {
				// Not readable: not ours to judge.
			}
		}
	}
	return { renders, dirs };
}

/**
 * The refusal for a render command while a narration it reaches does not carry
 * every brief point, or null. Runs before any approval card (pre-spawn).
 */
export function renderCoverageRefusal(command: string, cwd: string): string | null {
	if (checkOff()) return null;
	const { renders, dirs } = renderTargets(command, cwd);
	if (!renders) return null;
	for (const dir of dirs) {
		const found = coverageIn(dir);
		if (found && found.gaps.length > 0) {
			return `[BLOCKED] Render refused: ${describeGaps(found.gaps)}. ${KEEP_TERMS} in ${found.narration}, then render again.`;
		}
	}
	return null;
}

/**
 * After any command: if it wrote a video in the working folder or a folder
 * below it, beside a narration that still lacks a brief point, say so naming
 * the point. Catches renders the pre-spawn check could not recognise.
 */
export function renderedCoverageLine(cwd: string, sinceMs: number): string {
	if (checkOff()) return "";
	let dirs: string[] = [cwd];
	try {
		dirs = dirs.concat(
			readdirSync(cwd, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
				.map((e) => join(cwd, e.name)),
		);
	} catch {
		return "";
	}
	for (const dir of dirs) {
		let fresh: string[] = [];
		try {
			fresh = readdirSync(dir).filter(
				(n) => /\.(mp4|mov|webm|mkv)$/i.test(n) && statSync(join(dir, n)).mtimeMs >= sinceMs,
			);
		} catch {
			continue;
		}
		if (fresh.length === 0) continue;
		const found = coverageIn(dir);
		if (found && found.gaps.length > 0) {
			return `Render check: ${fresh.map((n) => join(dir, n)).join(", ")} was rendered but ${describeGaps(found.gaps)}. ${KEEP_TERMS} in ${found.narration}, then render again.`;
		}
	}
	return "";
}
