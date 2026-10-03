/**
 * failure-ledger.ts - failure-first error analysis for the autoresearch loop (#3420).
 *
 * One row per failing task, one named failure per row. The label comes from the
 * grader's own sub-checks (execution vs keyword, timeout, crash), never from a
 * model. The blended 70/30 score is not touched; this only adds visibility.
 *
 * Off by default. Only EIGHT_FAILURE_LEDGER=1 (exactly "1") turns it on. When on,
 * the loop may only apply mutations for a failure whose label has been seen at
 * least MIN_LABEL_COUNT times in the ledger. When off, gateMutations returns the
 * caller's mutations array untouched and does no file I/O.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { scrub } from "../../packages/eight/secret-scanner";
import type { CombinedGradeResult } from "../types";

export const MIN_LABEL_COUNT = 3;
export const EVIDENCE_MAX = 240;
/** Scrub only a bounded window, so no scanner rule ever sees unbounded input. */
const SCRUB_WINDOW = 4000;

export type FailureLabel =
	| "run-error"
	| "exec-timeout"
	| "exec-crash"
	| "no-code-extracted"
	| "exec-all-tests-failed"
	| "exec-some-tests-failed"
	| "keyword-miss"
	| "below-threshold";

export interface FailureRow {
	ts: string;
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

export function ledgerEnabled(env: Record<string, string | undefined> = process.env): boolean {
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
	const { scrubbed } = scrub(flat);
	return scrubbed.length > max ? `${scrubbed.slice(0, max - 3)}...` : scrubbed;
}

/** The single dominant failure for one graded run, or null when it passed. */
export function labelGrade(
	grade: CombinedGradeResult,
	opts: { passThreshold: number; hasTestHarness: boolean },
): Labelled | null {
	if (grade.score >= opts.passThreshold) return null;
	const exec = grade.execution;
	if (exec) {
		const out = exec.stderr || exec.stdout;
		if (exec.timedOut) return { label: "exec-timeout", check: "execution", evidence: out };
		if (exec.totalTests === 0) return { label: "exec-crash", check: "execution", evidence: out };
		if (exec.passedTests === 0)
			return { label: "exec-all-tests-failed", check: "execution", evidence: out };
		if (exec.failedTests > 0)
			return { label: "exec-some-tests-failed", check: "execution", evidence: out };
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

/** Pilot result.json checks: the first failing check names the failure (later ones usually cascade). */
export function labelChecks(
	checks: Array<{ name: string; pass: boolean; detail?: string }>,
): Labelled | null {
	const first = checks.find((c) => c.pass === false);
	return first ? { label: first.name, check: "pilot", evidence: first.detail ?? "" } : null;
}

export function makeRow(runId: string, taskId: string, l: Labelled, score: number | null): FailureRow {
	return {
		ts: new Date().toISOString(),
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

/** Labels by count, highest first; ties break by label for a stable order. */
export function labelCounts(rows: FailureRow[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export interface GateInput {
	env?: Record<string, string | undefined>;
	ledgerPath: string;
	runId: string;
	taskId: string;
	grade: CombinedGradeResult;
	hasTestHarness: boolean;
	passThreshold: number;
	mutations: string[];
}

export interface GateResult {
	apply: string[];
	deferred: string[];
	row: FailureRow | null;
	seen: number;
	note: string | null;
}

/**
 * Flag off: returns the caller's mutations array as is, no I/O.
 * Flag on: records one row for a failing run, then releases its mutations only
 * once that label has been seen MIN_LABEL_COUNT times across the ledger.
 */
export function gateMutations(input: GateInput): GateResult {
	if (!ledgerEnabled(input.env)) {
		return { apply: input.mutations, deferred: [], row: null, seen: 0, note: null };
	}
	const l = labelGrade(input.grade, input);
	if (!l) return { apply: [], deferred: input.mutations, row: null, seen: 0, note: null };
	const row = makeRow(input.runId, input.taskId, l, input.grade.score);
	appendRow(input.ledgerPath, row);
	const seen = readRows(input.ledgerPath).filter((r) => r.label === l.label).length;
	const open = seen >= MIN_LABEL_COUNT;
	const apply = open ? input.mutations : [];
	const deferred = open ? [] : input.mutations;
	const held = deferred.length > 0 ? `, ${deferred.length} mutation(s) held until seen ${MIN_LABEL_COUNT}x` : "";
	return { apply, deferred, row, seen, note: `  │ ledger: ${l.label} (seen ${seen}x)${held}` };
}

/** A run that threw before grading. No-op when the flag is off. */
export function recordRunError(
	env: Record<string, string | undefined>,
	ledgerPath: string,
	runId: string,
	taskId: string,
	err: unknown,
): FailureRow | null {
	if (!ledgerEnabled(env)) return null;
	const message = err instanceof Error ? err.message : String(err);
	const row = makeRow(runId, taskId, { label: "run-error", check: "run", evidence: message }, null);
	appendRow(ledgerPath, row);
	return row;
}
