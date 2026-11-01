#!/usr/bin/env bun
/**
 * validate-holdout.ts — FROZEN HOLD-OUT VALIDATOR (the P0-2 anti-train-on-test seam)
 *
 * This is the script the kernel's TrainingOrchestrator.validateHoldOut() shells
 * out to (packages/kernel/training.ts). Without it, the promotion gate could
 * never certify a candidate, so the self-learning loop failed CLOSED forever:
 * it trained but never learned into production. This file completes the loop
 * WHILE keeping the safety invariant intact.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CRITICAL SAFETY RULE (from 8SO, non-negotiable):
 *   NEVER validate a candidate against the same benchmark/training family it was
 *   optimized on. That is train-on-test, the exact poisoning path. The hold-out
 *   here is a SEALED, versioned set (holdout/v1.jsonl) that lives apart from any
 *   training corpus, is marked _frozen / _never_train_on, and is scored by
 *   OBJECTIVE correctness (exact / structured / contains), never a cloud judge.
 *
 * FAIL CLOSED:
 *   If the frozen hold-out is missing or empty, this writes a result the
 *   promotion gate REJECTS (perTask = {}), and exits non-zero. It NEVER emits a
 *   pass when it could not honestly measure.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CONTRACT (matched EXACTLY to packages/kernel/training.ts:396-417):
 *   training.ts spawns this script, then reads `holdout-results.json` from the
 *   SAME directory as the script and extracts:
 *
 *       return (results.perTask as Record<string, number>) ?? {};   // line 411
 *
 *   So `perTask` is the load-bearing key: a map of taskId -> CANDIDATE score
 *   (0..100). The promotion gate (promotion-gate.ts holdOutBeats) then compares
 *   that map against the baseline bar map (holdOut.tasks). The extra keys
 *   (candidate_score, baseline_score, n, holdout_id, timestamp, breakdown) are
 *   honest measurement metadata for humans and the canary seam; only `perTask`
 *   is consumed by training.ts today.
 *
 * Usage:
 *   bun run benchmarks/autoresearch/validate-holdout.ts \
 *       [--candidate-model <m>] [--baseline-model <m>] [--holdout <path>]
 *
 * Environment:
 *   TRAINING_PROXY_URL    — serves the CANDIDATE checkpoint (default http://localhost:30000)
 *   BASELINE_MODEL_URL    — serves the BASELINE/active model (default http://localhost:11434, Ollama)
 *   HOLDOUT_CANDIDATE_MODEL / HOLDOUT_BASELINE_MODEL — model ids
 *
 * Everything here is INERT until the kernel invokes it. Building it enables
 * nothing on its own.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── Paths ───────────────────────────────────────────────────────────

const SCRIPT_DIR = import.meta.dir; // benchmarks/autoresearch
// training.ts reads holdout-results.json from dirname(scriptPath) === SCRIPT_DIR.
export const RESULTS_PATH = resolve(SCRIPT_DIR, "holdout-results.json");
export const DEFAULT_HOLDOUT_PATH = resolve(SCRIPT_DIR, "holdout", "v1.jsonl");

// ── Types ───────────────────────────────────────────────────────────

export type MatchKind = "exact" | "json" | "contains" | "contains_normalized";

export interface HoldOutItem {
	id: string;
	prompt: string;
	expected: string;
	match: MatchKind;
}

/** The on-disk shape this script writes. `perTask` is the contract key. */
export interface HoldOutResultsFile {
	/** taskId -> CANDIDATE score (0..100). The ONLY key training.ts reads. */
	perTask: Record<string, number>;
	/** taskId -> BASELINE score (0..100). For the gate/canary + human audit. */
	perTaskBaseline: Record<string, number>;
	/** Frozen set identifier (e.g. "holdout-v1"). */
	holdout_id: string;
	/** Number of scored hold-out items (excludes metadata lines). */
	n: number;
	/** Candidate aggregate score (mean of perTask), 0..100. */
	candidate_score: number;
	/** Baseline aggregate score (mean of perTaskBaseline), 0..100. */
	baseline_score: number;
	/** ISO timestamp of the run. */
	timestamp: string;
	/** Per-item breakdown for human review. */
	breakdown: HoldOutItemResult[];
	/** True only when the hold-out was actually measured against both models. */
	measured: boolean;
	/** Human-readable status (e.g. why it failed closed). */
	status: string;
	/** Model ids actually used, for the audit trail. */
	candidateModel: string;
	baselineModel: string;
}

export interface HoldOutItemResult {
	id: string;
	match: MatchKind;
	candidateScore: number;
	baselineScore: number;
	candidateCorrect: boolean;
	baselineCorrect: boolean;
}

// ── Loading the FROZEN hold-out (separate-from-training guarantee) ──

/**
 * Parse the frozen hold-out JSONL. Lines whose parsed object begins with an
 * underscore-prefixed key (e.g. `_frozen`) are METADATA, not eval items, and are
 * skipped. This is the structural separation: the file is self-describing as
 * frozen/never-train-on, and the loader honors that marker.
 *
 * Throws if the marker is missing — a hold-out file that does not assert it is
 * frozen is not trusted as a hold-out (defensive: stops a training file being
 * passed in by mistake).
 */
export function loadHoldOut(path: string): { id: string; items: HoldOutItem[] } {
	if (!existsSync(path)) {
		return { id: "MISSING", items: [] };
	}
	const raw = readFileSync(path, "utf-8");
	const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

	let id = "unknown";
	let sawFrozenMarker = false;
	const items: HoldOutItem[] = [];

	for (const line of lines) {
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line);
		} catch {
			continue; // skip unparseable lines rather than crash
		}
		const keys = Object.keys(obj);
		const isMetadata = keys.length > 0 && keys.every((k) => k.startsWith("_"));
		if (isMetadata) {
			if (obj._frozen === true && obj._never_train_on === true) {
				sawFrozenMarker = true;
			}
			if (typeof obj._holdout_id === "string") id = obj._holdout_id;
			continue;
		}
		// Eval item: require the full structured shape, else skip (fail closed
		// on malformed items rather than scoring them as 0 silently).
		if (
			typeof obj.id === "string" &&
			typeof obj.prompt === "string" &&
			typeof obj.expected === "string" &&
			typeof obj.match === "string"
		) {
			items.push({
				id: obj.id as string,
				prompt: obj.prompt as string,
				expected: obj.expected as string,
				match: obj.match as MatchKind,
			});
		}
	}

	if (!sawFrozenMarker) {
		// The file did not assert it is a frozen, never-train-on hold-out.
		// Refuse to treat it as one. Returning empty items makes the gate REJECT.
		return { id: "UNSEALED", items: [] };
	}

	return { id, items };
}

// ── Objective scoring (NOT a cloud "judge liked it") ───────────────

function normalize(s: string): string {
	return s
		.trim()
		.toLowerCase()
		.replace(/```[a-z]*\n?/gi, "")
		.replace(/```/g, "")
		.replace(/[\s]+/g, "")
		.replace(/['"]/g, '"');
}

function jsonCanonical(s: string): string | null {
	// Strip code fences, then try to find the first JSON value in the text.
	const cleaned = s.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
	const candidates = [cleaned];
	const objMatch = cleaned.match(/[[{][\s\S]*[}\]]/);
	if (objMatch) candidates.push(objMatch[0]);
	for (const c of candidates) {
		try {
			return JSON.stringify(sortValue(JSON.parse(c)));
		} catch {
			// try next candidate
		}
	}
	return null;
}

function sortValue(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortValue);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as Record<string, unknown>).sort()) {
			out[k] = sortValue((v as Record<string, unknown>)[k]);
		}
		return out;
	}
	return v;
}

/**
 * Objective correctness for one hold-out item. Returns 100 (correct) or 0.
 * Deterministic and local: no network judge, no "vibe" scoring.
 */
export function scoreItem(item: HoldOutItem, output: string): number {
	const out = output ?? "";
	switch (item.match) {
		case "exact":
			return out.trim().toLowerCase() === item.expected.trim().toLowerCase() ? 100 : 0;
		case "contains":
			return out.toLowerCase().includes(item.expected.trim().toLowerCase()) ? 100 : 0;
		case "contains_normalized":
			return normalize(out).includes(normalize(item.expected)) ? 100 : 0;
		case "json": {
			const got = jsonCanonical(out);
			const want = jsonCanonical(item.expected);
			return got !== null && want !== null && got === want ? 100 : 0;
		}
		default:
			return 0;
	}
}

// ── Model invocation (matches the kernel pattern in proxy.ts / validate-checkpoint.ts) ──

export interface ModelTarget {
	/** Base URL serving the model's /api/chat endpoint. */
	url: string;
	/** Model id. */
	model: string;
	/** Label for logs/results ("candidate" | "baseline"). */
	label: string;
}

/**
 * Call a model the same way the kernel does: POST {url}/api/chat with
 * { model, messages, stream:false }, read data.message.content. Returns null on
 * any failure so the caller can fail closed for that target.
 */
export async function callModel(
	target: ModelTarget,
	prompt: string,
	timeoutMs = 60_000,
): Promise<string | null> {
	try {
		const res = await fetch(`${target.url}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: target.model,
				messages: [
					{
						role: "system",
						content:
							"You answer hold-out evaluation prompts exactly as instructed. Output only what the prompt asks for, with no extra prose.",
					},
					{ role: "user", content: prompt },
				],
				stream: false,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { message?: { content?: string } };
		return data.message?.content ?? "";
	} catch {
		return null;
	}
}

// ── Core: run BOTH candidate and baseline against the frozen set ────

export interface RunOptions {
	holdOutPath?: string;
	candidate: ModelTarget;
	baseline: ModelTarget;
	/** Injectable for tests: replaces callModel. */
	caller?: (target: ModelTarget, prompt: string) => Promise<string | null>;
}

/**
 * Build the results file by scoring both models on the frozen hold-out.
 * Pure-ish: I/O is the hold-out read + (injectable) model calls. Returns the
 * file object WITHOUT writing, so tests can assert on it directly.
 *
 * FAIL-CLOSED rules baked in:
 *   - missing/empty/unsealed hold-out  -> perTask = {}, measured=false
 *   - a candidate model call that fails -> that task is OMITTED from perTask
 *     (the gate treats a missing task as a regression -> reject). We never
 *     fabricate a score for a task we could not run on the candidate.
 */
export async function runHoldOut(opts: RunOptions): Promise<HoldOutResultsFile> {
	const holdOutPath = opts.holdOutPath ?? DEFAULT_HOLDOUT_PATH;
	const call = opts.caller ?? callModel;
	const { id, items } = loadHoldOut(holdOutPath);

	const base: HoldOutResultsFile = {
		perTask: {},
		perTaskBaseline: {},
		holdout_id: id,
		n: items.length,
		candidate_score: 0,
		baseline_score: 0,
		timestamp: new Date().toISOString(),
		breakdown: [],
		measured: false,
		status: "",
		candidateModel: opts.candidate.model,
		baselineModel: opts.baseline.model,
	};

	if (items.length === 0) {
		base.status =
			id === "MISSING"
				? "FAIL-CLOSED: frozen hold-out file missing"
				: id === "UNSEALED"
					? "FAIL-CLOSED: hold-out file is not marked frozen/never-train-on"
					: "FAIL-CLOSED: frozen hold-out is empty";
		return base; // perTask = {} -> gate rejects.
	}

	const perTask: Record<string, number> = {};
	const perTaskBaseline: Record<string, number> = {};
	const breakdown: HoldOutItemResult[] = [];

	for (const item of items) {
		const [candOut, baseOut] = await Promise.all([
			call(opts.candidate, item.prompt),
			call(opts.baseline, item.prompt),
		]);

		// Baseline: a failed call scores 0 (baseline bar drops, which is safe —
		// it only makes the candidate's job EASIER, never falsely promotes).
		const baselineScore = baseOut === null ? 0 : scoreItem(item, baseOut);
		perTaskBaseline[item.id] = baselineScore;

		// Candidate: a failed call means we CANNOT certify this task. OMIT it
		// from perTask so the gate counts it as a regression and rejects.
		if (candOut === null) {
			breakdown.push({
				id: item.id,
				match: item.match,
				candidateScore: 0,
				baselineScore,
				candidateCorrect: false,
				baselineCorrect: baselineScore >= 100,
			});
			continue; // do NOT add to perTask
		}

		const candidateScore = scoreItem(item, candOut);
		perTask[item.id] = candidateScore;
		breakdown.push({
			id: item.id,
			match: item.match,
			candidateScore,
			baselineScore,
			candidateCorrect: candidateScore >= 100,
			baselineCorrect: baselineScore >= 100,
		});
	}

	const candVals = Object.values(perTask);
	const baseVals = Object.values(perTaskBaseline);
	const candidate_score =
		candVals.length > 0
			? Math.round((candVals.reduce((a, b) => a + b, 0) / candVals.length) * 100) / 100
			: 0;
	const baseline_score =
		baseVals.length > 0
			? Math.round((baseVals.reduce((a, b) => a + b, 0) / baseVals.length) * 100) / 100
			: 0;

	// "measured" requires the candidate ran on EVERY item; a partial run leaves
	// at least one task missing from perTask, which the gate already rejects.
	const measured = Object.keys(perTask).length === items.length;

	return {
		perTask,
		perTaskBaseline,
		holdout_id: id,
		n: items.length,
		candidate_score,
		baseline_score,
		timestamp: new Date().toISOString(),
		breakdown,
		measured,
		status: measured
			? "measured: candidate and baseline scored on frozen hold-out"
			: "PARTIAL: candidate failed on >=1 task; those tasks omitted (gate will reject)",
		candidateModel: opts.candidate.model,
		baselineModel: opts.baseline.model,
	};
}

// ── CLI entry ───────────────────────────────────────────────────────

function argVal(flag: string, fallback: string): string {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
	const proxyUrl = process.env.TRAINING_PROXY_URL || "http://localhost:30000";
	const baselineUrl = process.env.BASELINE_MODEL_URL || "http://localhost:11434";

	const candidate: ModelTarget = {
		url: proxyUrl,
		model: argVal("--candidate-model", process.env.HOLDOUT_CANDIDATE_MODEL || "qwen3:14b"),
		label: "candidate",
	};
	const baseline: ModelTarget = {
		url: baselineUrl,
		model: argVal("--baseline-model", process.env.HOLDOUT_BASELINE_MODEL || "qwen3:14b"),
		label: "baseline",
	};
	const holdOutPath = argVal("--holdout", DEFAULT_HOLDOUT_PATH);

	console.log("\n╔══════════════════════════════════════════╗");
	console.log("║  FROZEN HOLD-OUT VALIDATOR (P0-2)         ║");
	console.log(`║  Hold-out: ${holdOutPath.split("/").slice(-2).join("/").padEnd(30).slice(0, 30)}║`);
	console.log(`║  Candidate: ${candidate.model.padEnd(29).slice(0, 29)}║`);
	console.log(`║  Baseline:  ${baseline.model.padEnd(29).slice(0, 29)}║`);
	console.log("╚══════════════════════════════════════════╝\n");

	const result = await runHoldOut({ holdOutPath, candidate, baseline });

	// ALWAYS write the results file (even on fail-closed) so training.ts can read
	// it. A fail-closed result has perTask = {} -> the gate rejects.
	writeFileSync(RESULTS_PATH, JSON.stringify(result, null, 2));

	console.log(`  Hold-out id:   ${result.holdout_id}`);
	console.log(`  Items (n):     ${result.n}`);
	console.log(`  Candidate avg: ${result.candidate_score}`);
	console.log(`  Baseline avg:  ${result.baseline_score}`);
	console.log(`  Measured:      ${result.measured}`);
	console.log(`  Status:        ${result.status}`);
	console.log(`\n  Wrote: ${RESULTS_PATH}\n`);

	// Exit non-zero when we could not honestly measure, so the loop fails closed
	// even on the process-exit signal (defense in depth alongside perTask = {}).
	if (!result.measured) process.exit(1);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
	main().catch((err) => {
		console.error(`Hold-out validation error: ${err}`);
		// Fail closed: write an empty-perTask result then exit non-zero.
		try {
			writeFileSync(
				RESULTS_PATH,
				JSON.stringify(
					{
						perTask: {},
						perTaskBaseline: {},
						holdout_id: "ERROR",
						n: 0,
						candidate_score: 0,
						baseline_score: 0,
						timestamp: new Date().toISOString(),
						breakdown: [],
						measured: false,
						status: `FAIL-CLOSED: ${err}`,
						candidateModel: "",
						baselineModel: "",
					},
					null,
					2,
				),
			);
		} catch {}
		process.exit(1);
	});
}
