/**
 * failure-ledger.ts - failure-first error analysis for the autoresearch loop (#3420).
 *
 * One row per failing task, one named failure per row. The label comes from the
 * grader's own sub-checks (execution vs keyword, timeout, no tests ran), never from
 * a model. The blended 70/30 score is not touched; this only adds visibility.
 *
 * Off by default. Only EIGHT_FAILURE_LEDGER=1 (exactly "1") turns it on. When on,
 * a task's mutations are applied only once the same task has failed with the same
 * label MIN_LABEL_COUNT times in the current run. Below that they are dropped, not
 * queued; the loop regenerates them the next time that task fails.
 * When off, gateMutations returns the caller's mutations array untouched and does
 * no file I/O.
 *
 * No function here throws: a ledger I/O error is reported in the returned note and
 * never escapes into the loop's per-benchmark handler.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { scrub } from "../../packages/eight/secret-scanner";
import type { CombinedGradeResult } from "../types";

export const MIN_LABEL_COUNT = 3;
export const EVIDENCE_MAX = 240;
export const EVIDENCE_DROPPED = "[evidence dropped: no token boundary]";
/** Scrub only a bounded window, so no scanner rule ever sees unbounded input. */
const SCRUB_WINDOW = 4000;

export type FailureLabel =
	| "run-error"
	| "exec-timeout"
	| "exec-no-tests-ran"
	| "no-code-extracted"
	| "exec-all-tests-failed"
	| "exec-some-tests-failed"
	| "keyword-miss"
	| "below-threshold";

export interface FailureRow {
	ts: string;
	/** The loop run (one invocation of the loop). Gate counts are scoped to it. */
	run: string;
	/** The iteration within the run, e.g. "<run>-iter2". */
	run_id: string;
	task_id: string;
	/** One named failure. Grader labels are FailureLabel; pilot labels are check names. */
	label: string;
	/** Which sub-check produced the label. */
	check: "run" | "execution" | "extraction" | "keyword" | "blended" | "pilot";
	score: number | null;
	evidence: string;
}

export interface Labelled {
	label: string;
	check: FailureRow["check"];
	evidence: string;
}

type Env = Record<string, string | undefined>;

export function ledgerEnabled(env: Env = process.env): boolean {
	return env.EIGHT_FAILURE_LEDGER === "1";
}

/** Flatten whitespace, scrub secrets, cap length. Linear time on any input. */
export function evidenceSnippet(text: string | null | undefined, max = EVIDENCE_MAX): string {
	const raw = text ?? "";
	let window = raw.slice(0, SCRUB_WINDOW);
	if (raw.length > SCRUB_WINDOW) {
		// Drop the token cut by the window: a half secret would not match a scrub rule.
		const cut = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"), window.lastIndexOf("\t"));
		window = cut > 0 ? window.slice(0, cut) : "";
	}
	const flat = window.split(/\s+/).filter(Boolean).join(" ");
	if (!flat && raw.trim()) return EVIDENCE_DROPPED;
	const { scrubbed } = scrub(flat);
	return scrubbed.length > max ? `${scrubbed.slice(0, max - 3)}...` : scrubbed;
}

/** Test output from the first "(fail)" or "error:" line, else from the top. indexOf only. */
export function execEvidence(stderr: string, stdout: string): string {
	const out = stderr || stdout || "";
	const lower = out.toLowerCase();
	const hits = [lower.indexOf("(fail)"), lower.indexOf("error:")].filter((i) => i >= 0);
	if (hits.length === 0) return out;
	const at = Math.min(...hits);
	return out.slice(out.lastIndexOf("\n", at) + 1);
}

/** The single dominant failure for one graded run, or null when it passed. */
export function labelGrade(
	grade: CombinedGradeResult,
	opts: { passThreshold: number; hasTestHarness: boolean },
): Labelled | null {
	if (grade.score >= opts.passThreshold) return null;
	const exec = grade.execution;
	if (exec) {
		const ev = execEvidence(exec.stderr, exec.stdout);
		if (exec.timedOut) return { label: "exec-timeout", check: "execution", evidence: ev };
		if (exec.totalTests === 0) return { label: "exec-no-tests-ran", check: "execution", evidence: ev };
		if (exec.passedTests === 0)
			return { label: "exec-all-tests-failed", check: "execution", evidence: ev };
		if (exec.failedTests > 0)
			return { label: "exec-some-tests-failed", check: "execution", evidence: ev };
	} else if (opts.hasTestHarness) {
		return {
			label: "no-code-extracted",
			check: "extraction",
			evidence: "no code block found in the model output; graded keyword-only",
		};
	}
	const missed = grade.keyword.missedKeywords;
	if (missed.length > 0)
		return { label: "keyword-miss", check: "keyword", evidence: `missed: ${missed.join(", ")}` };
	return { label: "below-threshold", check: "blended", evidence: `score=${grade.score}` };
}

/**
 * NOT WIRED into any loop. Used only by the read-only trial over pilot
 * result.json files: the first failing check names the failure.
 */
export function labelChecks(
	checks: Array<{ name: string; pass: boolean; detail?: string }>,
): Labelled | null {
	const first = checks.find((c) => c.pass === false);
	return first ? { label: first.name, check: "pilot", evidence: first.detail ?? "" } : null;
}

export function makeRow(
	run: string,
	runId: string,
	taskId: string,
	l: Labelled,
	score: number | null,
): FailureRow {
	return {
		ts: new Date().toISOString(),
		run,
		run_id: runId,
		task_id: taskId,
		label: l.label,
		check: l.check,
		score,
		evidence: evidenceSnippet(l.evidence),
	};
}

export function appendRow(path: string, row: FailureRow): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(row)}\n`);
}

export function readRows(path: string): FailureRow[] {
	if (!existsSync(path)) return [];
	const rows: FailureRow[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line);
			if (r && typeof r.label === "string") rows.push(r);
		} catch {
			// A torn or hand-edited line is skipped, never fatal.
		}
	}
	return rows;
}

export const taskLabel = (r: FailureRow): string => `${r.task_id}:${r.label}`;

/** Counts by key (label by default), highest first; ties break by key for a stable order. */
export function labelCounts(
	rows: FailureRow[],
	key: (r: FailureRow) => string = (r) => r.label,
): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface GateInput {
	env?: Env;
	ledgerPath: string;
	/** The loop run; counts only include rows from this run. */
	run: string;
	runId: string;
	taskId: string;
	grade: CombinedGradeResult;
	hasTestHarness: boolean;
	passThreshold: number;
	mutations: string[];
}

export interface GateResult {
	apply: string[];
	dropped: string[];
	row: FailureRow | null;
	seen: number;
	note: string | null;
}

/**
 * Flag off: returns the caller's mutations array as is, no I/O.
 * Flag on: records one row for a failing run, then applies its mutations only once
 * this task has failed with this label MIN_LABEL_COUNT times in this run. Otherwise
 * the mutations are dropped. A ledger error drops them too and says so in the note.
 */
export function gateMutations(input: GateInput): GateResult {
	if (!ledgerEnabled(input.env)) {
		return { apply: input.mutations, dropped: [], row: null, seen: 0, note: null };
	}
	const closed = (row: FailureRow | null, seen: number, note: string | null): GateResult => ({
		apply: [],
		dropped: input.mutations,
		row,
		seen,
		note,
	});
	try {
		const l = labelGrade(input.grade, input);
		if (!l) return closed(null, 0, null);
		const row = makeRow(input.run, input.runId, input.taskId, l, input.grade.score);
		appendRow(input.ledgerPath, row);
		const key = taskLabel(row);
		const seen = readRows(input.ledgerPath).filter(
			(r) => r.run === input.run && taskLabel(r) === key,
		).length;
		const note = `  │ ledger: ${key} (seen ${seen}x this run)`;
		if (seen >= MIN_LABEL_COUNT) {
			return { apply: input.mutations, dropped: [], row, seen, note };
		}
		const n = input.mutations.length;
		const tail =
			n > 0
				? `, ${n} mutation(s) dropped until seen ${MIN_LABEL_COUNT}x (regenerated on the next failure)`
				: "";
		return closed(row, seen, `${note}${tail}`);
	} catch (err) {
		return closed(null, 0, `  │ ⚠ ledger error, mutations dropped: ${errMessage(err)}`);
	}
}

/** A run that threw before grading. No-op when the flag is off. Never throws. */
export function recordRunError(
	env: Env,
	ledgerPath: string,
	run: string,
	runId: string,
	taskId: string,
	err: unknown,
): { row: FailureRow | null; note: string | null } {
	if (!ledgerEnabled(env)) return { row: null, note: null };
	try {
		const l: Labelled = { label: "run-error", check: "run", evidence: errMessage(err) };
		const row = makeRow(run, runId, taskId, l, null);
		appendRow(ledgerPath, row);
		return { row, note: null };
	} catch (e) {
		return { row: null, note: `  │ ⚠ ledger error: ${errMessage(e)}` };
	}
}

/** Top task+label counts for one run, as log lines. Empty when off. Never throws. */
export function runSummary(env: Env, ledgerPath: string, run: string, n = 3): string[] {
	if (!ledgerEnabled(env)) return [];
	try {
		const rows = readRows(ledgerPath).filter((r) => r.run === run);
		const top = labelCounts(rows, taskLabel).slice(0, n);
		if (top.length === 0) return ["  Ledger: no failures recorded this run"];
		return [
			`  Ledger top ${top.length} (task:label, this run):`,
			...top.map(([k, c]) => `    ${c}x ${k}`),
		];
	} catch (err) {
		return [`  ⚠ ledger summary error: ${errMessage(err)}`];
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
