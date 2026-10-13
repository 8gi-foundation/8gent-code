/**
 * 8gent Code - the narration of a brief video says every point of the brief (#4154).
 *
 * In pilot run 2026-10-13_034421/media-brief-video brief point 4 read "How to
 * help. We need volunteers to check and repair returned tools." and the
 * narration said "Help us by checking and repairing returned tools". The point
 * was paraphrased and its key noun, volunteers, dropped; nothing compared the
 * narration to the brief, so the video rendered without it.
 *
 * This is a property of the output: the narration as written on disk is
 * checked against each point of the brief (the numbered list plus a "Close on"
 * line in a brief beside the narration or one folder up; the slides when there
 * is no brief). It is
 *   - reported when the narration or slides are written (write_file),
 *   - refused before a render (run_command, both tool paths), and
 *   - reported after a command that rendered a video beside the narration.
 *
 * Scope, after the 8SO review: only a narration written by write_file in this
 * process, or one sitting in the folder a render writes its video into, is
 * ever judged; a render is a command whose executable is ffmpeg (directly or
 * on a line of a script it runs) writing a video file. Arguments, commit
 * messages and unrelated conversions never match. A refusal names nouns of a
 * point's label and its first sentence (its call to action); every other key
 * term the narration leaves out is a warning, never a refusal.
 *
 * The term heuristics (stemming, stopwords, determiners) are English only.
 * EIGHT_NARRATION_CHECK=0 (or false, off) turns every part of this off.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const SLIDES_NAMES = ["slides.md", "slides.markdown"];
const NARRATION_NAMES = ["narration.txt", "narration.md"];
const BRIEF_NAMES = ["brief.md", "BRIEF.md", "brief.txt"];
const VIDEO_OUT = /\.(mp4|mov|webm|mkv|m4v|avi)$/i;
const SCRIPT_MAX_BYTES = 64 * 1024;
const STOPWORDS = new Set(
	(
		"about above after again also anyone been before being both does doing down during each even every from have " +
		"having here into just like make made more most much must need needs only other ours over same should some such " +
		"than that their them then there these they this those through under until very want were what when where which " +
		"while will with would your yours itself"
	).split(" "),
);
/** A word after one of these (modifiers between allowed) is a noun. */
const NOUN_MARKERS = new Set(
	"a an the our your their its this that these those each every any some no of at in on for by with from per".split(
		" ",
	),
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

/** Narrations write_file wrote in this process: the only ones judged without a render naming their folder. */
const writtenNarrations = new Set<string>();

/** Test hook: forget the narrations written so far. */
export function forgetWrittenNarrations(): void {
	writtenNarrations.clear();
}

function checkOff(): boolean {
	return /^(0|false|off)$/i.test(process.env.EIGHT_NARRATION_CHECK ?? "");
}

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

const isWord = (t: string | undefined): t is string => t !== undefined && /^[\p{L}\d]+$/u.test(t);
const candidate = (w: string) =>
	/^\p{L}{4,}$/u.test(w) && !STOPWORDS.has(w.toLowerCase()) && !/(ing|ed|ly)$/i.test(w);

interface Term {
	word: string;
	/** A noun the point names: a refusal when the narration never says it. */
	strong: boolean;
}

/**
 * The key terms a passage names. A candidate is four letters or more, not a
 * stopword, not an -ing/-ed/-ly form. A lowercase candidate directly followed
 * by another candidate is a modifier ("free membership card" keys on "card").
 * A term is strong (a noun) when it is plural, a name (capitalised mid-sentence
 * or before another capitalised word), or follows a determiner or preposition
 * with only modifiers between; a word right after "to" is a verb.
 */
function keyTerms(text: string): Map<string, Term> {
	const terms = new Map<string, Term>();
	const tokens = [...clean(text).matchAll(/[\p{L}\d]+|[^\p{L}\d]+/gu)].map((m) => m[0]);
	const joined = (i: number) => tokens[i] !== undefined && /^[ \t-]+$/.test(tokens[i]);
	for (let i = 0; i < tokens.length; i++) {
		const w = tokens[i];
		if (!isWord(w) || !candidate(w)) continue;
		const next = joined(i + 1) ? tokens[i + 2] : undefined;
		const capital = /^\p{Lu}/u.test(w);
		if (isWord(next) && candidate(next) && !capital) continue;
		const prevGap = tokens[i - 1];
		const sentenceStart = i === 0 || (prevGap !== undefined && /[.!?:"]\s*$/.test(prevGap));
		let strong = /[^su]s$/i.test(w) && !/(ss|is|us)$/i.test(w);
		if (capital && (!sentenceStart || (isWord(next) && /^\p{Lu}/u.test(next)))) strong = true;
		let j = i - 1;
		while (!strong && j >= 1 && joined(j)) {
			const before = tokens[j - 1];
			if (!isWord(before)) break;
			const lower = before.toLowerCase();
			if (lower === "to" || /^(and|or|but|nor)$/.test(lower) || /(ing|ed)$/.test(lower)) break;
			if (NOUN_MARKERS.has(lower) || /^\d+$/.test(before) || NUMBER_WORDS.includes(lower))
				strong = true;
			else if (/^\p{L}+$/u.test(before) && before.length >= 3 && !STOPWORDS.has(lower)) j -= 2;
			else break;
		}
		const s = stem(w);
		const had = terms.get(s);
		if (!had) terms.set(s, { word: w.toLowerCase(), strong });
		else if (strong) had.strong = true;
	}
	return terms;
}

/**
 * A point of the brief: its label ("How to help"), the text that says it, and
 * whether the label's own nouns count (not for the "Close on" line).
 */
export interface BriefPoint {
	label: string;
	text: string;
	labelTerms?: false;
}

function labelled(p: string): BriefPoint {
	const m = /^([^.!?:]{1,40})[.:]\s+(\S.*)$/.exec(p);
	if (m && m[1].trim().split(/\s+/).length <= 5) return { label: m[1].trim(), text: m[2] };
	return {
		label: p
			.split(/\s+/)
			.slice(0, 5)
			.join(" ")
			.replace(/[.!?:,;]+$/, ""),
		text: p,
	};
}

/**
 * The points of a brief, in order: each numbered item ("4. How to help. We
 * need ..." gives label "How to help"), then a `Close on:` line, which the
 * video must end on. Continuation lines belong to their point.
 */
export function briefPoints(brief: string): BriefPoint[] {
	const points: BriefPoint[] = [];
	let open = false;
	for (const line of brief.replace(/\r\n?/g, "\n").split("\n")) {
		const m = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
		const close = /^\s{0,3}close on\s*:\s*(.+)$/i.exec(line);
		if (m) {
			points.push(labelled(m[1].trim()));
			open = true;
		} else if (close) {
			const text = close[1].trim().replace(/^["“]|["”]$/g, "");
			points.push({ label: "Close on", text, labelTerms: false });
			open = false;
		} else if (open && line.trim() !== "" && !/^\s{0,3}(#|[-*+]\s)/.test(line)) {
			points[points.length - 1].text += ` ${line.trim()}`;
		} else {
			open = false;
		}
	}
	return points;
}

/** The slides as points, when there is no brief: heading as label, body as text. */
export function slidePoints(slidesMd: string): BriefPoint[] {
	const body = slidesMd
		.replace(/\r\n?/g, "\n")
		.replace(/^---\n[\s\S]*?\n---\n(?=[\s\S])/, (fm) =>
			/^---\n(\s*[\w-]+\s*:.*\n|\s.*\n)+---\n$/.test(fm) ? "" : fm,
		);
	return body
		.split(/^---[ \t]*$/m)
		.map((section) => section.split("\n"))
		.filter((s) => s.some((l) => l.trim() !== ""))
		.map((lines) => {
			const head = lines.find((l) => l.trim() !== "") ?? "";
			const body = lines.filter((l) => l.trim() !== "" && !/^\s{0,3}#/.test(l));
			const label = head
				.replace(/^\s*#+\s*/, "")
				.trim()
				.replace(/[.!?:]+$/, "");
			return { label, text: (body.length > 0 ? body : [head]).join("\n") };
		});
}

/** One point the narration does not carry: the nouns it never says (refused) and other terms (warned). */
export interface NarrationGap {
	label: string;
	missing: string[];
	alsoUnsaid: string[];
}

function firstSentence(text: string): string {
	return /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
}

/**
 * Every point the narration does not fully carry. `missing` holds the nouns of
 * the point's label and first sentence that are never spoken (when a point
 * has no such noun, all of its terms, if none is spoken). `alsoUnsaid` holds
 * the point's other unspoken terms. Empty when everything is said.
 */
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
		// The label adds nouns to the call to action, never warnings ("How to help" warns of nothing).
		const label = p.labelTerms === false ? "" : `${p.label}. `;
		const all = keyTerms(p.text);
		const head = keyTerms(`${label}${firstSentence(p.text)}`);
		const nouns = [...head].filter(([, t]) => t.strong).map(([s]) => s);
		let required = nouns;
		if (required.length === 0 && ![...all.keys()].some((s) => spoken.has(s)))
			required = [...all.keys()];
		const missing = required
			.filter((s) => !spoken.has(s))
			.map((s) => (all.get(s) ?? head.get(s))?.word ?? s);
		const alsoUnsaid = [...all]
			.filter(([s]) => !spoken.has(s) && !required.includes(s))
			.map(([, t]) => t.word);
		if (missing.length > 0 || alsoUnsaid.length > 0)
			gaps.push({ label: p.label, missing, alsoUnsaid });
	}
	return gaps;
}

/** "the narration has no segment for: How to help (missing: volunteers)". Named, never counted. */
export function describeGaps(gaps: NarrationGap[]): string {
	const hard = gaps.filter((g) => g.missing.length > 0);
	return `the narration has no segment for: ${hard.map((g) => `${g.label} (missing: ${g.missing.join(", ")})`).join("; ")}`;
}

function describeWarnings(gaps: NarrationGap[]): string {
	const soft = gaps.filter((g) => g.alsoUnsaid.length > 0);
	return soft.map((g) => `${g.label} (${g.alsoUnsaid.join(", ")})`).join("; ");
}

const KEEP_TERMS =
	'Give each point its own segment and keep the nouns it names word for word (a call to action names what is needed, for example "we need volunteers to ...")';
const OPT_OUT = "If this is not a narrated brief video, set EIGHT_NARRATION_CHECK=0.";

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
 * The narration in `dir` checked against the brief beside it or one folder up
 * (beside its video/ folder), or the slides in `dir` when there is no brief.
 */
function coverageIn(dir: string): Coverage | null {
	const narration = firstIn(dir, NARRATION_NAMES);
	if (!narration) return null;
	try {
		const brief = firstIn(dir, BRIEF_NAMES) || firstIn(dirname(dir), BRIEF_NAMES);
		const points = brief ? briefPoints(readFileSync(brief, "utf8")) : [];
		if (points.length > 0) {
			return {
				narration,
				source: brief,
				gaps: narrationGaps(points, readFileSync(narration, "utf8")),
			};
		}
		const slides = firstIn(dir, SLIDES_NAMES);
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

const hasHard = (c: Coverage | null): c is Coverage =>
	c?.gaps.some((g) => g.missing.length > 0) === true;

/**
 * After write_file wrote `filePath` (absolute): remember a narration, and name
 * every point the narration does not carry. "" when there is nothing to say.
 */
export function narrationCoverageAfterWrite(filePath: string): string {
	const name = basename(filePath);
	if (checkOff() || !isAbsolute(filePath)) return "";
	if (NARRATION_NAMES.includes(name)) writtenNarrations.add(filePath);
	else if (!SLIDES_NAMES.includes(name)) return "";
	const found = coverageIn(dirname(filePath));
	if (!found || found.gaps.length === 0) return "";
	const lines: string[] = [];
	if (hasHard(found)) {
		lines.push(
			`Coverage against ${basename(found.source)}: ${describeGaps(found.gaps)}. ${KEEP_TERMS}, or the render will be refused.`,
		);
	}
	const warn = describeWarnings(found.gaps);
	if (warn)
		lines.push(
			`Coverage warning: the narration never says these words from ${basename(found.source)}: ${warn}.`,
		);
	return lines.join("\n");
}

/**
 * Split a shell command into simple commands, each a list of words with quotes
 * removed. Separators inside quotes are words, so `git commit -m "a; ffmpeg"`
 * stays one command whose executable is git.
 */
export function simpleCommands(command: string): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let quote: string | null = null;
	let started = false;
	const endWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	const endCommand = () => {
		endWord();
		if (words.length > 0) out.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
			else word += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			started = true;
		} else if (c === "\\" && command[i + 1] === "\n") {
			i++;
		} else if (c === "\\" && i + 1 < command.length) {
			word += command[++i];
			started = true;
		} else if (/[;&|\n()]/.test(c)) {
			endCommand();
		} else if (/\s/.test(c)) {
			endWord();
		} else if (c === "#" && !started) {
			const nl = command.indexOf("\n", i);
			i = nl < 0 ? command.length : nl - 1;
		} else {
			word += c;
			started = true;
		}
	}
	endCommand();
	return out;
}

/** The executable of a simple command: past `VAR=x`, `env`/`exec`/`time`/`nice` and shell keywords (`do`, `then`). */
function executable(words: string[]): { raw: string; exe: string; args: string[] } {
	let i = 0;
	while (
		i < words.length &&
		(/^\w+=/.test(words[i]) ||
			/^(env|exec|time|nice|command|do|then|else|elif|!|\{)$/.test(words[i]))
	)
		i++;
	const raw = words[i] ?? "";
	return { raw, exe: basename(raw), args: words.slice(i + 1) };
}

/** The video files a ffmpeg invocation writes: its last argument, when that is a video path. */
function ffmpegOutputs(args: string[]): string[] {
	const last = args[args.length - 1];
	return last && !last.startsWith("-") && VIDEO_OUT.test(last) ? [last] : [];
}

/** A regular file under the size cap, read; "" otherwise (a FIFO named x.sh must not hang the turn). */
function readScript(path: string): string {
	try {
		const st = statSync(path);
		if (!st.isFile() || st.size > SCRIPT_MAX_BYTES) return "";
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/**
 * The folders the video outputs of `command` land in: a simple command whose
 * executable is ffmpeg, or a script it runs (`bash x.sh`, `sh x.sh`, `./x.sh`)
 * with such a line. `cd` before a render moves it; inside a script, `cd` is
 * resolved against both the folder the script runs from and the script's own
 * folder (the pilot's video/build.sh does `cd video` from the work folder).
 */
function renderFolders(command: string, cwd: string, depth = 0): Set<string> {
	const dirs = new Set<string>();
	let here = [cwd];
	for (const words of simpleCommands(command)) {
		const { raw, exe, args } = executable(words);
		if (exe === "cd" && args[0]) {
			here = here.map((d) => resolve(d, args[0]));
			continue;
		}
		if (exe === "ffmpeg") {
			for (const out of ffmpegOutputs(args))
				for (const d of here) dirs.add(dirname(resolve(d, out)));
			continue;
		}
		const script = /^(ba|z|da)?sh$/.test(exe) ? args.find((a) => !a.startsWith("-")) : raw;
		if (!script || depth > 0 || !/\.(sh|bash|zsh)$/.test(script)) continue;
		for (const d of here) {
			const abs = resolve(d, script);
			const body = readScript(abs);
			if (!body) continue;
			for (const base of new Set([d, dirname(abs)])) {
				for (const dir of renderFolders(body, base, depth + 1)) dirs.add(dir);
			}
		}
	}
	return dirs;
}

/**
 * The refusal for a render while a narration it is bound to does not carry
 * every brief point, or null. Bound means: the narration sits in the folder
 * the render writes its video into, or write_file wrote it in this process.
 * Runs before any approval card (pre-spawn).
 */
export function renderCoverageRefusal(command: string, cwd: string): string | null {
	if (checkOff()) return null;
	const outputs = renderFolders(command, cwd);
	if (outputs.size === 0) return null;
	const dirs = new Set<string>(outputs);
	for (const n of writtenNarrations) dirs.add(dirname(n));
	for (const dir of dirs) {
		const found = coverageIn(dir);
		if (hasHard(found)) {
			return `[RENDER CHECK] Render refused: ${describeGaps(found.gaps)}. ${KEEP_TERMS} in ${found.narration}, then render again. ${OPT_OUT}`;
		}
	}
	return null;
}

/**
 * After any command: if a video was written since `sinceMs` beside a narration
 * write_file wrote in this process, and that narration still lacks a point,
 * say so naming the point. Only those folders are scanned.
 */
export function renderedCoverageLine(sinceMs: number): string {
	if (checkOff() || writtenNarrations.size === 0) return "";
	for (const narration of writtenNarrations) {
		const dir = dirname(narration);
		let fresh: string[] = [];
		try {
			fresh = readdirSync(dir).filter(
				(n) => VIDEO_OUT.test(n) && statSync(join(dir, n)).mtimeMs >= sinceMs,
			);
		} catch {
			continue;
		}
		if (fresh.length === 0) continue;
		const found = coverageIn(dir);
		if (hasHard(found)) {
			return `Render check: ${fresh.map((n) => join(dir, n)).join(", ")} was rendered but ${describeGaps(found.gaps)}. ${KEEP_TERMS} in ${found.narration}, then render again.`;
		}
	}
	return "";
}
