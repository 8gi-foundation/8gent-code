/**
 * Turn results: what a finished turn did, as checked steps.
 *
 *   ✓ Wrote  deck/outline.md
 *   ✗ Ran  bun test  exit 1
 *   ✓ Read  packages/decide/  5 files
 *
 * Mockup A's "DONE" block. While a turn runs, chat shows the live tool trail
 * (one row per call, lib/tool-trail.ts). When the reply lands, the same calls
 * render as results: a bold verb, the path or command in a chip, and a quiet
 * note. Two real sources, nothing else:
 *
 * 1. The turn's tool trail. Every row is a call that ran, with the status the
 *    tool itself reported. Reads and searches in a row fold into one line;
 *    repeated writes to one file fold into one line with a count.
 * 2. The turn's plan: the one the PLAN column held when the reply landed
 *    (stamped on the reply by app.tsx), or else the turn's last update_plan
 *    call (#3044). Its steps lead the block with the status the agent
 *    reported. A step still marked in progress when the turn ended is shown
 *    as not done, exactly as the PLAN column settles it (settlePlan).
 *
 * No description, verb or step is invented: verbs are a fixed map from tool
 * names, an unknown tool shows its own name, and plan steps are shown in the
 * agent's own words.
 */

import { type PlanStep, applyPlanUpdate, settlePlan } from "./plan-state.js";
import type { ToolTrailEntry, TrailStatus } from "./tool-trail.js";

export type ResultStatus = TrailStatus | "pending";

export interface ResultRow {
	kind: "plan" | "tool" | "fold";
	status: ResultStatus;
	/** Bold. For a plan step, its first word. */
	verb: string;
	/** Plan steps only: the rest of the step text, normal weight. */
	text?: string;
	/** Path, command or query, drawn as a chip. */
	chip?: string;
	/** Quiet trailing note: "5 files", "×3", "exit 1". */
	note?: string;
	/** Calls this row stands for. */
	count: number;
	/** Fold rows only: the plan steps folded into this row. */
	steps?: number;
}

/** A turn's result block never grows past this many rows. */
export const MAX_RESULT_ROWS = 10;

/** [verb when it worked, verb when it failed]. */
const VERBS: Record<string, [string, string]> = {
	write_file: ["Wrote", "Write failed"],
	edit_file: ["Edited", "Edit failed"],
	delete_file: ["Deleted", "Delete failed"],
	read_file: ["Read", "Read failed"],
	read_pdf: ["Read", "Read failed"],
	read_pdf_page: ["Read", "Read failed"],
	get_outline: ["Outlined", "Outline failed"],
	get_project_outline: ["Outlined", "Outline failed"],
	get_symbol: ["Read", "Read failed"],
	list_files: ["Listed", "List failed"],
	search_symbols: ["Searched", "Search failed"],
	search_pdf: ["Searched", "Search failed"],
	locate: ["Searched", "Search failed"],
	web_search: ["Searched the web", "Web search failed"],
	web_fetch: ["Fetched", "Fetch failed"],
	run_command: ["Ran", "Run failed"],
	git_add: ["Staged", "Stage failed"],
	git_commit: ["Committed", "Commit failed"],
	git_status: ["Checked", "Check failed"],
	git_diff: ["Checked", "Check failed"],
	git_log: ["Checked", "Check failed"],
	remember: ["Remembered", "Remember failed"],
	recall: ["Recalled", "Recall failed"],
	spawn_agent: ["Started agent", "Agent failed"],
};

/** Verbs whose consecutive successes fold into one row. */
const FOLDABLE = new Set([
	"Read",
	"Listed",
	"Searched",
	"Searched the web",
	"Fetched",
	"Checked",
	"Outlined",
]);
/** Verbs whose repeats on the same target fold into one row with a count. */
const REPEATABLE = new Set(["Wrote", "Edited", "Ran", "Staged"]);

/** Tools whose trail rows are bookkeeping, not work: they never show as a result. */
const NOT_RESULTS = new Set(["update_plan"]);

function chipFor(entry: ToolTrailEntry): string | undefined {
	if (entry.summary) return entry.summary;
	if (entry.tool.startsWith("git_")) return `git ${entry.tool.slice(4)}`;
	return undefined;
}

function toolRow(entry: ToolTrailEntry): ResultRow {
	const verbs = VERBS[entry.tool];
	const chip = chipFor(entry);
	if (entry.status === "blocked") {
		const why = entry.reason?.replace(/^blocked:?\s*/, "") || undefined;
		// "Run blocked", "Write blocked": the same words as a failure, so the
		// reader sees what was stopped, not only that something was.
		const verb = verbs ? verbs[1].replace(/failed$/, "blocked") : `${entry.tool} blocked`;
		return { kind: "tool", status: "blocked", verb, chip, note: why, count: 1 };
	}
	if (entry.status === "fail") {
		// A command that exited non-zero did run; say so, with the exit code.
		const verb =
			entry.tool === "run_command" && /^exit /.test(entry.reason ?? "")
				? "Ran"
				: (verbs?.[1] ?? entry.tool);
		return { kind: "tool", status: "fail", verb, chip, note: entry.reason, count: 1 };
	}
	return { kind: "tool", status: "ok", verb: verbs?.[0] ?? entry.tool, chip, count: 1 };
}

/** Longest shared directory prefix of paths, ending in "/", or "". */
function commonDir(paths: string[]): string {
	const split = paths.map((p) => p.split("/").slice(0, -1));
	const first = split[0] ?? [];
	let n = 0;
	while (n < first.length && split.every((s) => s[n] === first[n])) n++;
	return n > 0 ? `${first.slice(0, n).join("/")}/` : "";
}

function foldNote(verb: string, n: number): string {
	if (verb === "Read" || verb === "Outlined") return `${n} files`;
	if (verb === "Listed") return `${n} folders`;
	if (verb === "Fetched") return `${n} pages`;
	return `×${n}`;
}

/** The turn's plan as the agent last reported it, settled for a finished turn. */
export function turnPlan(trail: ToolTrailEntry[]) {
	for (let i = trail.length - 1; i >= 0; i--) {
		const e = trail[i];
		if (e.tool === "update_plan" && e.status === "ok" && e.plan && e.plan.length > 0) {
			return settlePlan(applyPlanUpdate([], e.plan));
		}
	}
	return [];
}

function planRows(plan: ReadonlyArray<PlanStep>): ResultRow[] {
	return plan.map((s) => {
		const [first, ...rest] = s.text.split(/\s+/);
		const status: ResultStatus =
			s.status === "done" ? "ok" : s.status === "failed" ? "fail" : "pending";
		return { kind: "plan", status, verb: first ?? "", text: rest.join(" ") || undefined, count: 1 };
	});
}

function toolRows(trail: ToolTrailEntry[]): ResultRow[] {
	const out: ResultRow[] = [];
	const runs: string[][] = [];
	for (const entry of trail) {
		if (NOT_RESULTS.has(entry.tool)) continue;
		const row = toolRow(entry);
		const prev = out[out.length - 1];
		// Consecutive successful reads, lists and searches: one row.
		if (
			prev &&
			row.status === "ok" &&
			prev.status === "ok" &&
			prev.verb === row.verb &&
			FOLDABLE.has(row.verb)
		) {
			runs[out.length - 1].push(row.chip ?? "");
			prev.count += 1;
			continue;
		}
		// The same write, edit or command again: one row with a count.
		if (row.status === "ok" && REPEATABLE.has(row.verb)) {
			const same = out.findIndex(
				(r) => r.status === "ok" && r.verb === row.verb && r.chip === row.chip,
			);
			if (same >= 0) {
				out[same].count += 1;
				continue;
			}
		}
		out.push(row);
		runs.push([row.chip ?? ""]);
	}
	return out.map((row, i) => {
		if (row.count <= 1) return row;
		if (FOLDABLE.has(row.verb)) {
			const chips = runs[i].filter(Boolean);
			const unique = new Set(chips);
			const chip = unique.size === 1 ? chips[0] : commonDir(chips) || undefined;
			return { ...row, chip, note: foldNote(row.verb, row.count) };
		}
		return { ...row, note: `×${row.count}` };
	});
}

/**
 * The result rows for a finished turn: plan steps first (when the turn had a
 * plan), then what the calls did, in order. Past `maxRows`, the oldest
 * successful calls fold into one "N more actions" row, and after them the
 * pending plan steps into one "N more steps" row, so failures, blocks and
 * finished plan steps stay visible for as long as the space allows.
 *
 * `plan` is the plan the PLAN column holds for this turn (app.tsx stamps it
 * on the reply), so the two surfaces count the same steps. Without one, the
 * turn's own update_plan calls stand in (turnPlan). Either way the word
 * "step" only ever counts plan steps: the plan rows plus the steps in a
 * fold row always add up to the plan's length.
 */
export function buildTurnResults(
	trail: ToolTrailEntry[],
	maxRows = MAX_RESULT_ROWS,
	plan: ReadonlyArray<PlanStep> = turnPlan(trail),
): ResultRow[] {
	const rows = [...planRows(plan), ...toolRows(trail)];
	const cap = Math.max(1, Math.floor(maxRows));
	if (rows.length <= cap) return rows;
	// Plan steps and calls never share a fold row, so a fold of both kinds
	// costs two rows. Try with one summary row, then with two.
	let fold = pickFolds(rows, rows.length - cap + 1);
	if (foldsBothKinds(rows, fold) && cap >= 2) fold = pickFolds(rows, rows.length - cap + 2);
	const out: ResultRow[] = [];
	const summarised = new Set<string>();
	const combine = foldsBothKinds(rows, fold) && cap < 2;
	for (let i = 0; i < rows.length; i++) {
		if (!fold.has(i)) {
			out.push(rows[i]);
			continue;
		}
		// A fold row sits where the first row it stands for was.
		const kind = combine ? "all" : rows[i].kind === "plan" ? "plan" : "tool";
		if (summarised.has(kind)) continue;
		summarised.add(kind);
		const members = [...fold]
			.map((j) => rows[j])
			.filter((r) => kind === "all" || (r.kind === "plan") === (kind === "plan"));
		out.push(foldRow(members));
	}
	return out;
}

/** Rows to fold, as indexes: `n` of them, least informative first. */
function pickFolds(rows: ResultRow[], n: number): Set<number> {
	let toFold = n;
	const fold = new Set<number>();
	// Pass 1: successful calls, oldest first. Pass 2: pending plan steps.
	// Pass 3 (only when still too many): anything, oldest first.
	const passes: Array<(r: ResultRow) => boolean> = [
		(r) => r.kind === "tool" && r.status === "ok",
		(r) => r.kind === "plan" && r.status === "pending",
		() => true,
	];
	for (const want of passes) {
		for (let i = 0; i < rows.length && toFold > 0; i++) {
			if (fold.has(i) || !want(rows[i])) continue;
			fold.add(i);
			toFold--;
		}
	}
	return fold;
}

function foldsBothKinds(rows: ResultRow[], fold: Set<number>): boolean {
	const kinds = new Set([...fold].map((i) => rows[i].kind === "plan"));
	return kinds.size > 1;
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * One row standing for folded rows. Plan steps say "steps", calls say
 * "actions"; when a one-row window forces both into one row, the steps lead
 * and the calls follow in the note.
 */
function foldRow(members: ResultRow[]): ResultRow {
	const steps = members.filter((r) => r.kind === "plan");
	const calls = members.filter((r) => r.kind !== "plan").reduce((n, r) => n + r.count, 0);
	const failed = members.filter((r) => r.status === "fail").length;
	const blocked = members.filter((r) => r.status === "blocked").length;
	const pending = steps.filter((r) => r.status === "pending").length;
	const done = steps.filter((r) => r.status === "ok").length;
	const notes: string[] = [];
	// A fold of steps that are not all alike says how many were done, so a
	// pending icon never hides a finished step and a tick never claims one.
	if (steps.length > 0 && done > 0 && done < steps.length) notes.push(`${done} done`);
	if (failed) notes.push(`${failed} failed`);
	if (blocked) notes.push(`${blocked} blocked`);
	if (steps.length > 0 && calls > 0) notes.push(`+${plural(calls, "action", "actions")}`);
	return {
		kind: "fold",
		status: failed ? "fail" : blocked ? "blocked" : pending ? "pending" : "ok",
		verb:
			steps.length > 0
				? `${plural(steps.length, "more step", "more steps")}`
				: `${plural(calls, "more action", "more actions")}`,
		note: notes.length ? notes.join(", ") : undefined,
		count: steps.length + calls,
		steps: steps.length,
	};
}

/** How many plan steps the rows stand for: plan rows plus folded steps. */
export function stepsShown(rows: ReadonlyArray<ResultRow>): number {
	return rows.reduce((n, r) => n + (r.kind === "plan" ? 1 : (r.steps ?? 0)), 0);
}

export interface FittedRow {
	verb: string;
	text?: string;
	chip?: string;
	note?: string;
	/** Spaces before the note: 1 after a chip, 2 otherwise. */
	noteGap?: number;
}

function clip(s: string, width: number): string {
	if (width <= 0) return "";
	return s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Fit a row into `width` columns, counting the icon, the spaces between
 * parts and the chip's one column of padding each side. The chip is cut
 * first (its tail, where a long path or command runs on), then the note,
 * then the step text. The verb is never cut unless nothing else is left.
 */
export function fitResultRow(row: ResultRow, width: number): FittedRow {
	// "✓ " = 2 columns.
	let room = Math.max(1, width - 2);
	const verb = clip(row.verb, room);
	room -= verb.length;
	const out: FittedRow = { verb };
	if (row.text && room > 1) {
		out.text = clip(row.text, room - 1);
		room -= 1 + out.text.length;
	}
	const noteCost = row.note ? row.note.length + 1 : 0;
	if (row.chip && room > 3) {
		// " " + " chip " = 3 columns around the chip text.
		const chipRoom = room - 3 - (room - 3 - noteCost >= 8 ? noteCost : 0);
		if (chipRoom >= 1) {
			out.chip = clip(row.chip, chipRoom);
			room -= 3 + out.chip.length;
		}
	}
	// After a chip its own padding is the gap, so one space; otherwise two.
	const gap = out.chip ? 1 : 2;
	if (row.note && room > gap) {
		out.note = clip(row.note, room - gap);
		out.noteGap = gap;
	}
	return out;
}

/** Rows a result block occupies, for MessageList's row-budget math. */
export function turnResultRows(
	trail: ToolTrailEntry[],
	maxRows?: number,
	plan?: ReadonlyArray<PlanStep>,
): number {
	return buildTurnResults(trail, maxRows, plan).length;
}
