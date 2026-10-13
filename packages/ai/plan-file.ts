/**
 * The plan of record (#4161): a checklist file in the project beats the
 * update_plan sidebar.
 *
 * When the working tree holds a Markdown checklist plan (PLAN.md, plan.md or
 * TODO.md at the root, or a file the task names), that file is what the
 * person reads and what a reviewer checks. Pilot run 2026-10-13_074318
 * (approve-go-ahead-practice): the model called update_plan three times, the
 * sidebar said "5 of 5 steps done", PLAN.md still had three open boxes, and
 * the reply said all three steps were complete.
 *
 * So update_plan (packages/ai/update-plan.ts) names the file in its result,
 * and refuses to mark a step done while the matching box is still open; the
 * TUI PLAN column shows the file's tick count beside its own. With no such
 * file nothing changes.
 *
 * Reads only, confined to the working directory, never writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Root files that hold a plan by convention, in the order they are tried. */
export const PLAN_FILE_NAMES = ["PLAN.md", "plan.md", "TODO.md"] as const;

/** Files whose checkboxes are documentation, never a plan of record. */
const NOT_A_PLAN = /^(readme|changelog|contributing|license)(\.[a-z]+)?$/i;

const MAX_PLAN_BYTES = 256 * 1024;

export interface PlanBox {
	/** The item text, without the checkbox or its leading "1." number. */
	text: string;
	checked: boolean;
	/** The item's own number when the file numbers it ("- [ ] 2. ..."). */
	number?: number;
}

export interface PlanFile {
	/** Path relative to the working directory, as the model should name it. */
	name: string;
	boxes: PlanBox[];
}

// The task each working directory is on, noted by the agent at turn start so
// a plan file the task names ("go ahead with docs/rollout.md") is found too.
// Keyed by directory, so two agents in one process do not share it.
const taskByDir = new Map<string, string>();

/** Remember the current task text for a working directory (agent turn start). */
export function notePlanTask(workingDirectory: string, task: string): void {
	taskByDir.set(path.resolve(workingDirectory), task);
}

/** Markdown and text files the task text names, in the order it names them. */
export function namedPlanFiles(task: string): string[] {
	const out: string[] = [];
	for (const m of task.matchAll(
		/(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:md|markdown|txt))(?=$|[\s`'").,:;!?\]])/gi,
	)) {
		const name = m[1];
		if (!out.includes(name) && !NOT_A_PLAN.test(path.basename(name))) out.push(name);
	}
	return out;
}

/** The checklist lines of a Markdown file: `- [ ] text` and `- [x] text`. */
export function parseCheckboxes(content: string): PlanBox[] {
	const boxes: PlanBox[] = [];
	for (const line of content.split(/\r?\n/)) {
		const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*\S)\s*$/.exec(line);
		if (!m) continue;
		const numbered = /^(\d+)[.)]\s+(.*)$/.exec(m[2]);
		boxes.push({
			checked: m[1] !== " ",
			text: numbered ? numbered[2] : m[2],
			...(numbered ? { number: Number(numbered[1]) } : {}),
		});
	}
	return boxes;
}

function readInside(workingDirectory: string, name: string): string | null {
	try {
		const root = fs.realpathSync(workingDirectory);
		const target = fs.realpathSync(path.resolve(root, name));
		const rel = path.relative(root, target);
		if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
		const stat = fs.statSync(target);
		if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) return null;
		return fs.readFileSync(target, "utf8");
	} catch {
		return null;
	}
}

// A task that talks about a plan or a checklist may mean a root PLAN.md or
// TODO.md without naming it; any other task leaves a backlog TODO.md alone.
const PLAN_WORDS = /\b(plan|checklist|todo|tick)\b/i;

/**
 * The plan of record in `workingDirectory`: the first file the task names,
 * then a root PLAN.md, plan.md or TODO.md when the task speaks of a plan, a
 * checklist, a todo or ticking, whichever first holds a checkbox. A root
 * backlog file the task has nothing to do with is never the record. Null
 * when there is none, which leaves update_plan exactly as it was.
 */
export function findPlanFile(workingDirectory: string, task?: string): PlanFile | null {
	const noted = task ?? taskByDir.get(path.resolve(workingDirectory)) ?? "";
	const named = namedPlanFiles(noted);
	const candidates = [...named, ...(PLAN_WORDS.test(noted) ? PLAN_FILE_NAMES : [])];
	for (const name of candidates) {
		const content = readInside(workingDirectory, name);
		if (content === null) continue;
		const boxes = parseCheckboxes(content);
		if (boxes.length > 0) return { name: name.replace(/^\.\//, ""), boxes };
	}
	return null;
}

const STOP = new Set(
	"a an the to of in on for and or it its so also is be with from by as at that this each every other md markdown txt".split(
		" ",
	),
);

function words(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w && !STOP.has(w)),
	);
}

/**
 * The box a plan step refers to, or undefined. A step that starts with a
 * number ("2. Update README", "Step 2: ...") is the box with that number when
 * the file numbers its items and the two share a content word: the model's
 * own numbering alone ("1. Read PLAN.md") is not the file's item 1. Otherwise
 * it is the box whose words cover most
 * of the step's words, when they cover at least 60% and two words: models
 * paraphrase ("Add src/slugify.ts + test under test/"), and a step that
 * matches nothing is not refused.
 */
export function matchBox(step: string, boxes: ReadonlyArray<PlanBox>): PlanBox | undefined {
	const want = words(step);
	const n = /^\s*(?:step\s*)?(\d+)\s*[.):\-]/i.exec(step);
	if (n) {
		const byNumber = boxes.find((b) => b.number === Number(n[1]));
		const rest = words(step.slice(n[0].length));
		const have = byNumber ? words(byNumber.text) : new Set<string>();
		if (byNumber && [...rest].some((w) => have.has(w))) return byNumber;
	}
	if (want.size === 0) return undefined;
	let best: PlanBox | undefined;
	let bestScore = 0;
	for (const box of boxes) {
		const have = words(box.text);
		let shared = 0;
		for (const w of want) if (have.has(w)) shared++;
		const score = shared / want.size;
		if (shared >= 2 && score >= 0.6 && score > bestScore) {
			best = box;
			bestScore = score;
		}
	}
	return best;
}

/** How a box is named back to the model: "PLAN.md item 2" or the item text. */
export function boxLabel(file: PlanFile, box: PlanBox): string {
	if (box.number !== undefined) return `${file.name} item ${box.number}`;
	const short = box.text.length > 60 ? `${box.text.slice(0, 59)}…` : box.text;
	return `${file.name} "${short}"`;
}

/** Ticked and total boxes, for the result line and the PLAN column. */
export function planFileCount(file: PlanFile): { ticked: number; total: number } {
	return { ticked: file.boxes.filter((b) => b.checked).length, total: file.boxes.length };
}

/** The line that names the file of record; update_plan's result carries it verbatim. */
export function planOfRecordLine(file: PlanFile): string {
	const { ticked, total } = planFileCount(file);
	return `the plan of record is ${file.name}; tick its boxes with edit_file (${ticked} of ${total} ticked)`;
}
